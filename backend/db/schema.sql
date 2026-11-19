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
  env_name VARCHAR(255) NOT NULL DEFAULT 'alphafold3_alphapulldown',
  -- AlphaFold database directory passed to create_individual_features.py as
  -- --data_dir (jackhmmer/hhblits searches and templates). Empty until the
  -- user sets it in Setup - the MSA stage refuses to run without it.
  data_dir VARCHAR(500) NOT NULL DEFAULT '/home/linuxhomes/software/genetic_db',
  -- The installed AlphaPulldown (2.9) builds features with AlphaFold 3's data
  -- pipeline, which searches the local databases only (it has no MMseqs2
  -- mode). Its pdb_seqres file sits in a subfolder here, so it is passed
  -- explicitly; empty = let the tool look in data_dir.
  pdb_seqres_path VARCHAR(500) NOT NULL DEFAULT '/home/linuxhomes/software/genetic_db/pdb_seqres/pdb_seqres.txt',
  max_template_date VARCHAR(10) NOT NULL DEFAULT '2050-01-01',
  -- Resource request of ONE MSA array task (one protein).
  -- Empty = omit --partition and let the cluster pick its default.
  msa_partition VARCHAR(100) NOT NULL DEFAULT '',
  msa_cpus_per_task INT NOT NULL DEFAULT 8,
  msa_mem VARCHAR(20) NOT NULL DEFAULT '64G',
  msa_time VARCHAR(20) NOT NULL DEFAULT '10:00:00',
  -- How many proteins one MSA job searches at once (its single allocation
  -- holds this many per-protein slots), and how many ABCFold jobs may be in
  -- flight at once.
  msa_array_throttle INT NOT NULL DEFAULT 4,
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

-- The shared library: ONE row (id 1), written by staff in Setup. library_dir
-- is the folder that holds every proteome and every feature set, one copy for
-- all users. feature_set_tag is bumped by staff whenever the genetic
-- databases or the AlphaPulldown software are updated, so features built with
-- the old and the new setup never share a folder.
CREATE TABLE IF NOT EXISTS alphapulldown_library_config (
  id TINYINT NOT NULL PRIMARY KEY,
  library_dir VARCHAR(500) NOT NULL DEFAULT '',
  feature_set_tag VARCHAR(32) NOT NULL DEFAULT 'v1',
  updated_by BIGINT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per proteome VERSION in the library: a UniProt proteome id at one
-- UniProt release, either all entries or reviewed (Swiss-Prot) only. Files
-- are immutable; a new release is a new row. metadata.json beside the FASTA
-- holds the same facts (and more) on disk; this row is the index the tab
-- lists and the key sequences and runs point at. sha256 is of proteome.fasta.
CREATE TABLE IF NOT EXISTS alphapulldown_library_proteomes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  upid VARCHAR(12) NOT NULL,
  release_name VARCHAR(10) NOT NULL,
  release_date VARCHAR(30) NOT NULL DEFAULT '',
  subset VARCHAR(10) NOT NULL DEFAULT 'all',
  organism VARCHAR(255) NOT NULL DEFAULT '',
  tax_id INT NULL,
  proteome_type VARCHAR(50) NOT NULL DEFAULT '',
  entries INT NOT NULL DEFAULT 0,
  bytes BIGINT NOT NULL DEFAULT 0,
  sha256 CHAR(64) NOT NULL DEFAULT '',
  source VARCHAR(120) NOT NULL DEFAULT '',
  metadata_json MEDIUMTEXT NULL,
  downloaded_at DATETIME NOT NULL,
  added_by BIGINT NULL,
  UNIQUE KEY uniq_proteome_version (upid, release_name, subset)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per feature set: the AlphaPulldown input features of one proteome
-- version under one build configuration (format, template cut-off, database
-- folder, staff tag). set_key is the folder name under <library>/features/.
-- The software and database versions the files were built with are recorded
-- by the first job that builds into the set, in set.json beside the files,
-- and every later job checks them before adding anything.
CREATE TABLE IF NOT EXISTS alphapulldown_library_feature_sets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  proteome_id BIGINT NOT NULL,
  set_key VARCHAR(120) NOT NULL,
  tag VARCHAR(32) NOT NULL,
  format VARCHAR(20) NOT NULL DEFAULT 'af3_json',
  max_template_date VARCHAR(10) NOT NULL,
  data_dir VARCHAR(500) NOT NULL,
  created_by BIGINT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_set_key (set_key),
  KEY idx_proteome_id (proteome_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The Target tab. A target is the protein (one chain) or complex (several
-- chains) the user is interested in; there is at most one per project, and
-- only its owner sees it (developers and administrators may read all).
-- It is saved as a draft whether or not it is validated or confirmed; the
-- Baits tab opens only once status is 'confirmed'.
--   genome_*     the UniProt proteome the user chose as the source organism's
--                genome (genome_json keeps the UniProt record as it was when
--                chosen, and what the user typed to find it)
--   model_*      the 3D model of the target, if any: where it came from (a PDB
--                entry, the AlphaFold DB, a model predicted with ABCFold, an
--                uploaded file), its id and version, the stored file (relative
--                to the project folder) with its checksum, the chains read
--                from it, and which of the target's chains it was matched
--                to. model_state is 'selected' until the user accepts it.
--   chimera_json the user's acknowledgement of a chimeric complex: the chains
--                that were not confirmed, the warning text shown, and when.
-- status 'draft' | 'confirmed'; free-form strings, not ENUMs (no migrations).
CREATE TABLE IF NOT EXISTS alphapulldown_targets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT NOT NULL,
  owner_id BIGINT NOT NULL,
  name VARCHAR(255) NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  genome_upid VARCHAR(12) NULL,
  genome_organism VARCHAR(255) NULL,
  genome_tax_id INT NULL,
  genome_json MEDIUMTEXT NULL,
  model_source VARCHAR(20) NULL,
  model_id VARCHAR(60) NULL,
  model_version VARCHAR(60) NULL,
  model_file VARCHAR(255) NULL,
  model_filename VARCHAR(255) NULL,
  model_sha256 CHAR(64) NULL,
  model_bytes BIGINT NULL,
  model_state VARCHAR(20) NULL,
  model_json MEDIUMTEXT NULL,
  model_mapping_json MEDIUMTEXT NULL,
  model_fetched_at DATETIME NULL,
  model_accepted_at DATETIME NULL,
  validated_at DATETIME NULL,
  chimera_json MEDIUMTEXT NULL,
  confirmed_at DATETIME NULL,
  confirmed_by BIGINT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_target_project (project_id),
  KEY idx_target_owner (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The chains of a target. sequence is what is used (the user's own text is
-- the golden rule); original_sequence is what UniProt had when the chain was
-- started from an accession (NULL for a sequence the user brought), so the
-- edits can be described. uniprot_json is the UniProt record as fetched: the
-- release it came from and its date, organism, taxon, proteomes, entry and
-- sequence versions. validation_* is the result of checking the chain against
-- the chosen genome ('matched', 'not_matched' or 'not_checked', and how).
CREATE TABLE IF NOT EXISTS alphapulldown_target_chains (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  target_id BIGINT NOT NULL,
  position INT NOT NULL,
  label VARCHAR(100) NOT NULL,
  origin VARCHAR(12) NOT NULL DEFAULT 'sequence',
  accession VARCHAR(30) NULL,
  copies INT NOT NULL DEFAULT 1,
  length INT NOT NULL,
  sequence MEDIUMTEXT NOT NULL,
  original_sequence MEDIUMTEXT NULL,
  edit_kind VARCHAR(12) NULL,
  edit_summary VARCHAR(500) NULL,
  uniprot_json MEDIUMTEXT NULL,
  validation_status VARCHAR(12) NULL,
  validation_json MEDIUMTEXT NULL,
  validated_at DATETIME NULL,
  UNIQUE KEY uniq_target_label (target_id, label),
  KEY idx_target_id (target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- What happened to a target and when: saved, checked against the genome,
-- model loaded or accepted, chimera acknowledged, confirmed. The dates the
-- methods text needs, kept even when a later edit reopens the target.
CREATE TABLE IF NOT EXISTS alphapulldown_target_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  target_id BIGINT NOT NULL,
  user_id BIGINT NULL,
  event VARCHAR(40) NOT NULL,
  detail_json TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_target_events (target_id, id)
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
-- proteome (those live once in the shared library). proteome_id/accession
-- tie a protein picked from a library proteome to that exact proteome
-- version; they are NULL for pasted or single-UniProt sequences.
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
  proteome_id BIGINT NULL,
  accession VARCHAR(30) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_project_role_name (project_id, role, name),
  KEY idx_project_id (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per MSA run: a single Slurm job that searches the project's
-- proteins (see backend/services/msaPlan.js). The run's own folder
-- (run_dir, relative to the project folder) holds the scripts, the per-protein
-- logs and timings.tsv; protein names live only there and in the project's
-- own sequences, never in this table. method/hardware/cpus snapshot what was
-- asked for so the run's speed samples stay correct if Setup changes later.
-- speed_ingested_at is the private-side marker that this run's timings were
-- already copied (anonymised) into alphapulldown_speed_samples.
CREATE TABLE IF NOT EXISTS alphapulldown_msa_runs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT NOT NULL,
  owner_id BIGINT NOT NULL,
  run_dir VARCHAR(255) NOT NULL,
  slurm_job_id VARCHAR(40) NULL,
  -- Slurm's own state words (PENDING, RUNNING, COMPLETED, ...); PREPARING
  -- while the files are being written, before the job is submitted.
  state VARCHAR(30) NOT NULL DEFAULT 'PREPARING',
  total INT NOT NULL,
  to_do INT NOT NULL,
  parallel INT NOT NULL,
  redo TINYINT(1) NOT NULL DEFAULT 0,
  method VARCHAR(50) NOT NULL DEFAULT '',
  hardware VARCHAR(100) NOT NULL DEFAULT '',
  -- Everything needed to write the methods of this run: which proteome
  -- versions and feature sets it used, the settings, and (added when the job
  -- ends) the software and database versions the job itself recorded. The
  -- same text is in provenance.json in the run's folder. See provenance.js.
  provenance_json MEDIUMTEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME NULL,
  ended_at DATETIME NULL,
  speed_ingested_at DATETIME NULL,
  KEY idx_project_id (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per co-folding run: a batch of bait-candidate pairs, each folded by
-- its own ABCFold job (through the ABCFold module, see
-- backend/services/abcfoldClient.js). max_parallel snapshots how many of them
-- may be in flight at once; the other columns snapshot the options asked for
-- so the run's speed samples stay correct if the defaults change later.
-- method/hardware are the labels the run's samples are filed under.
CREATE TABLE IF NOT EXISTS alphapulldown_cofold_runs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT NOT NULL,
  owner_id BIGINT NOT NULL,
  total INT NOT NULL,
  max_parallel INT NOT NULL,
  model_seeds INT NOT NULL DEFAULT 1,
  -- 'default' (leave it to the ABCFold module's own setting), 'yes' or 'no'.
  mmseqs2 VARCHAR(10) NOT NULL DEFAULT 'default',
  templates TINYINT(1) NOT NULL DEFAULT 0,
  gpu_count INT NOT NULL DEFAULT 1,
  -- 1 = hand ABCFold the MSA file from the MSA stage where there is one.
  reuse_msa TINYINT(1) NOT NULL DEFAULT 0,
  method VARCHAR(50) NOT NULL DEFAULT '',
  hardware VARCHAR(100) NOT NULL DEFAULT '',
  -- The proteome versions and feature sets of the project's proteins when the
  -- run was created, plus the options asked for (see provenance.js).
  provenance_json MEDIUMTEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  cancelled_at DATETIME NULL,
  KEY idx_project_id (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per pair of a co-folding run. bait_name/cand_name are the project's
-- own protein names (cand_name is NULL for a homo-oligomer, which folds one
-- protein alone); they live here and never in the speed samples. state is
-- QUEUED (not submitted yet), SUBMITTING, SUBMIT_FAILED, or - once ABCFold's
-- job exists - Slurm's own state words. abcfold_job_id/slurm_job_id are the
-- ids the ABCFold module answered with. speed_ingested_at is the private-side
-- marker that this pair's timings were copied (anonymised) into
-- alphapulldown_speed_samples.
CREATE TABLE IF NOT EXISTS alphapulldown_cofold_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT NOT NULL,
  project_id BIGINT NOT NULL,
  bait_name VARCHAR(255) NOT NULL,
  cand_name VARCHAR(255) NULL,
  len_a INT NOT NULL,
  len_b INT NULL,
  state VARCHAR(30) NOT NULL DEFAULT 'QUEUED',
  attempts INT NOT NULL DEFAULT 0,
  last_error VARCHAR(500) NULL,
  abcfold_job_id VARCHAR(40) NULL,
  slurm_job_id VARCHAR(40) NULL,
  claimed_at DATETIME NULL,
  checked_at DATETIME NULL,
  slurm_submitted_at DATETIME NULL,
  started_at DATETIME NULL,
  ended_at DATETIME NULL,
  speed_ingested_at DATETIME NULL,
  KEY idx_run_state (run_id, state),
  KEY idx_project_pair (project_id, bait_name, cand_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Anonymised speed samples: how long one MSA search or one co-folding job
-- took for a given size on given hardware. Shared by every user of this
-- module and used to estimate future runs; each finished job adds one row.
-- Deliberately holds NO owner, project, job, accession, protein name,
-- sequence or timestamp finer than a day - only sizes, a method label, a
-- hardware label, timings and an outcome. The link between a private job
-- and the sample it produced lives only on the private side (the
-- speed_ingested_at column on the MSA run and co-folding item rows), so a sample cannot be traced back to anyone. There is
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
