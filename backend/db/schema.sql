-- This module's own tables. No migrations, ever - this file is the single
-- source of truth for this module's schema, edited directly (same rule as
-- mff-core's own App_backend/install/schema.sql). Every table MUST be
-- prefixed with module.manifest.json's tablePrefix ("alphapulldown_" -
-- rename both together if you rename the module).
--
-- Imported by mff-core's own moduleDatabaseProvisioner.js, against this
-- module's own dedicated database (mff_module_<id>) created for it at
-- Install/Update time - see backend/config/database.js's header comment for
-- how this module reads it, and mff-core's own
-- docs/MFF-Core_module-database-provisioning.md for how core provisions it.
--
-- Core's schema diffing only ever ADDS tables and columns: a column added
-- later must be nullable or carry a DEFAULT, and a column's type is never
-- changed after the fact. Tables for the MSA stage and the co-folding stage
-- are added in the phases that build them.

-- One row per user, upserted from the Setup tab. Holds this module's OWN
-- resource request for the CPU (MSA) stage and its AlphaPulldown environment
-- settings. The co-folding stage runs through the ABCFold module, which has
-- its own per-user settings - nothing about GPU jobs is stored here.
-- account/email come straight from coreApi at request time (req.user.username,
-- coreApi.listUsers()), and every output directory comes from
-- coreApi.getUserWorkspacePath(req.user) - none of them is cached here.
-- Every value below ends up inside a generated sbatch script, so
-- backend/routes/settingsRoutes.js validates each one against a strict
-- pattern before it is ever stored.
CREATE TABLE IF NOT EXISTS alphapulldown_settings (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  owner_id BIGINT NOT NULL,
  slurm_mail_type VARCHAR(50) NOT NULL DEFAULT 'BEGIN,END,FAIL',
  -- 'micromamba' or 'conda' - which environment manager activates env_name
  -- in the generated sbatch script. Not an ENUM: this file has no
  -- migrations, ever, and a free-form default is easier to extend later.
  env_manager VARCHAR(20) NOT NULL DEFAULT 'micromamba',
  env_name VARCHAR(255) NOT NULL DEFAULT 'alphapulldown',
  -- AlphaFold database directory passed to create_individual_features.py as
  -- --data_dir (jackhmmer/hhblits searches and templates). Empty until the
  -- user sets it in Setup - the MSA stage refuses to run without it.
  data_dir VARCHAR(500) NOT NULL DEFAULT '',
  -- 1 = ask the public ColabFold MMseqs2 API for MSAs (needs internet from
  -- the compute node) instead of searching data_dir.
  msa_use_mmseqs2 TINYINT(1) NOT NULL DEFAULT 0,
  max_template_date VARCHAR(10) NOT NULL DEFAULT '2050-01-01',
  -- Resource request of ONE MSA array task (one protein).
  -- Empty = omit --partition and let the cluster pick its default.
  msa_partition VARCHAR(100) NOT NULL DEFAULT '',
  msa_cpus_per_task INT NOT NULL DEFAULT 8,
  msa_mem VARCHAR(20) NOT NULL DEFAULT '64G',
  msa_time VARCHAR(20) NOT NULL DEFAULT '10:00:00',
  -- How many array tasks / ABCFold jobs may be in flight at once (the %K of
  -- --array=1-N%K, and the co-folding submission cap).
  msa_array_throttle INT NOT NULL DEFAULT 20,
  cofold_max_parallel INT NOT NULL DEFAULT 20,
  -- A complex longer than this (residues) is flagged as unlikely to be
  -- feasible. Defaults to AlphaPulldown's own length filter for AlphaFold2.
  warn_max_complex_aa INT NOT NULL DEFAULT 5000,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_owner_id (owner_id)
  -- No FK to setup_users(id) here on purpose: this module's own schema
  -- shouldn't be tightly coupled to core's internal table structure.
  -- owner_id is validated at the application layer (req.user.id, from
  -- coreApi.authenticateToken) instead.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A project owns one set of proteins and ties the three stages together
-- (sequences -> MSA -> co-folding). project_number is per-owner sequential
-- (1, 2, 3, ...), shown as "P<number>" and used to name the project's own
-- folder under the user's workspace (module-AlphaPulldown/P<number>) - not
-- the same as id, which is global across every user.
CREATE TABLE IF NOT EXISTS alphapulldown_projects (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  owner_id BIGINT NOT NULL,
  project_number INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  -- 'pulldown' (baits x candidates), 'all_vs_all' or 'homo_oligomer'.
  -- Free-form, not ENUM, for the same no-migrations reason as above.
  mode VARCHAR(20) NOT NULL DEFAULT 'pulldown',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_owner_project_number (owner_id, project_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The proteins chosen for a project - only the selected ones, never a whole
-- downloaded proteome (that stays a file in the user's workspace).
-- role: 'bait' or 'candidate' for pulldown, 'all' for all_vs_all and
-- homo_oligomer. name is the AlphaPulldown-safe identifier (it becomes the
-- feature file name and the entry in the protein-list files).
CREATE TABLE IF NOT EXISTS alphapulldown_project_sequences (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT NOT NULL,
  role VARCHAR(20) NOT NULL,
  name VARCHAR(255) NOT NULL,
  -- 'uniprot', 'proteome' or 'paste' - where the sequence came from.
  source VARCHAR(20) NOT NULL DEFAULT 'paste',
  description VARCHAR(500) NULL,
  length INT NOT NULL,
  sequence MEDIUMTEXT NOT NULL,
  -- Copy number inside the complex (homo-oligomer state); 1 for a monomer.
  copies INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_project_role_name (project_id, role, name),
  KEY idx_project_id (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Anonymised speed samples: how long one MSA search or one co-folding job
-- took for a given size on given hardware. Shared by every user of this
-- module and used to estimate future runs; each finished job adds one row.
-- Deliberately holds NO owner, project, job, accession, protein name,
-- sequence or timestamp finer than a day - only sizes, a method label, a
-- hardware label, timings and an outcome. The link between a private job
-- and the sample it produced lives only on the private side (a
-- speed_ingested_at column on the job rows, added with the stages that
-- create them), so a sample cannot be traced back to anyone. There is
-- intentionally no route that lets a client write here: rows come only from
-- backend/services/speedRecorder.js, from jobs this module itself observed.
-- stage: 'msa' (one protein, len_b NULL) or 'fold' (one complex of one or two
-- proteins, total_len = all chains together).
-- method: short label of what was run (e.g. 'mmseqs2' or 'local' for the MSA
-- stage); hardware: short label of where (e.g. 'partition/8cpu').
CREATE TABLE IF NOT EXISTS alphapulldown_speed_samples (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  stage VARCHAR(10) NOT NULL,
  len_a INT NOT NULL,
  len_b INT NULL,
  total_len INT NOT NULL,
  method VARCHAR(50) NOT NULL DEFAULT '',
  hardware VARCHAR(100) NOT NULL DEFAULT '',
  -- 'ok', 'oom', 'timeout' or 'failed'. Only 'ok' rows give a duration;
  -- the others are kept to flag sizes that tend not to finish.
  outcome VARCHAR(10) NOT NULL DEFAULT 'ok',
  run_seconds INT NOT NULL,
  queue_seconds INT NULL,
  sampled_on DATE NOT NULL,
  KEY idx_stage_class (stage, method, hardware, total_len)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which roles can see which of this module's tabs (Page Access tab, staff
-- only). A page with no rows here is invisible to non-staff users - staff
-- (canManageUsers) always see every tab regardless of this table's content.
CREATE TABLE IF NOT EXISTS alphapulldown_page_access (
  page_key VARCHAR(100) NOT NULL,
  role VARCHAR(50) NOT NULL,
  PRIMARY KEY (page_key, role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
