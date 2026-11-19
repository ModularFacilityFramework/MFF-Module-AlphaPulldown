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
-- changed after the fact. A column removed from this file therefore stays
-- behind, unused, in a database that already has it; the code never reads one.

-- One row per user, upserted from the Setup tab. Holds this module's OWN
-- resource requests for both AlphaPulldown stages - the CPU feature stage
-- (create_individual_features.py) and the GPU prediction stage
-- (run_multimer_jobs.py) - and the AlphaPulldown environment they run in.
-- The defaults describe this cluster's installation (AlphaPulldown 2.9 with
-- AlphaFold 3 in the micromamba environment "alphafold3_alphapulldown"); every
-- one of them can be changed per user in Setup.
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
  -- in the generated sbatch scripts. Not an ENUM: this file has no
  -- migrations, ever, and a free-form default is easier to extend later.
  env_manager VARCHAR(20) NOT NULL DEFAULT 'micromamba',
  -- The environment that has AlphaPulldown installed (create_individual_features.py,
  -- run_multimer_jobs.py on the PATH) together with AlphaFold 3.
  env_name VARCHAR(255) NOT NULL DEFAULT 'alphafold3_alphapulldown',
  -- Genetic database directory passed to create_individual_features.py as
  -- --data_dir (AlphaFold 3 layout: uniref90_2022_05.fa, mgy_clusters_2022_05.fa,
  -- ..., mmcif_files/). The feature stage refuses to run without it.
  data_dir VARCHAR(500) NOT NULL DEFAULT '/home/linuxhomes/software/genetic_db',
  -- Optional --pdb_seqres_database_path. AlphaPulldown looks for
  -- <data_dir>/pdb_seqres_2022_09_28.fasta; this cluster keeps the file at
  -- pdb_seqres/pdb_seqres.txt instead. Empty = leave it to AlphaPulldown.
  pdb_seqres_path VARCHAR(500) NOT NULL DEFAULT '/home/linuxhomes/software/genetic_db/pdb_seqres/pdb_seqres.txt',
  -- AlphaFold 3 model weights directory, passed to run_multimer_jobs.py as
  -- --data_dir (the weights file af3.bin lives in it).
  weights_dir VARCHAR(500) NOT NULL DEFAULT '/home/linuxhomes/software/alphafold3/models',
  max_template_date VARCHAR(10) NOT NULL DEFAULT '2050-01-01',
  -- Resource request of ONE protein of the feature stage.
  -- Empty = omit --partition and let the cluster pick its default.
  msa_partition VARCHAR(100) NOT NULL DEFAULT '',
  msa_cpus_per_task INT NOT NULL DEFAULT 8,
  msa_mem VARCHAR(20) NOT NULL DEFAULT '64G',
  msa_time VARCHAR(20) NOT NULL DEFAULT '10:00:00',
  -- How many proteins one feature job searches at once (its single allocation
  -- holds this many per-protein slots).
  msa_array_throttle INT NOT NULL DEFAULT 4,
  -- Resource request of ONE prediction job (one complex = one Slurm job).
  fold_partition VARCHAR(100) NOT NULL DEFAULT 'gpu',
  fold_gres VARCHAR(50) NOT NULL DEFAULT 'gpu:1',
  fold_cpus_per_task INT NOT NULL DEFAULT 8,
  fold_mem VARCHAR(20) NOT NULL DEFAULT '64G',
  fold_time VARCHAR(20) NOT NULL DEFAULT '24:00:00',
  -- 1 = let AlphaFold 3 spill into host memory when the GPU's memory is full
  -- (XLA_PYTHON_CLIENT_PREALLOCATE=false, TF_FORCE_UNIFIED_MEMORY=true,
  -- XLA_CLIENT_MEM_FRACTION=3.2 - AlphaFold 3's own recommendation); slower,
  -- but lets a 24 GB GPU fold larger complexes.
  fold_unified_memory TINYINT(1) NOT NULL DEFAULT 1,
  -- How many prediction jobs may be in flight at once.
  cofold_max_parallel INT NOT NULL DEFAULT 20,
  -- A complex longer than this (residues) is flagged as unlikely to be
  -- feasible.
  warn_max_complex_aa INT NOT NULL DEFAULT 5000,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_owner_id (owner_id)
  -- No FK to setup_users(id) here on purpose: this module's own schema
  -- shouldn't be tightly coupled to core's internal table structure.
  -- owner_id is validated at the application layer (req.user.id, from
  -- coreApi.authenticateToken) instead.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A project owns one set of proteins and ties the stages together
-- (sequences -> features -> prediction -> results). project_number is per-owner sequential
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

-- One row per feature run: a single Slurm job that runs
-- create_individual_features.py for the project's proteins (the MSA and
-- template search, see backend/services/msaPlan.js). The run's own folder
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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME NULL,
  ended_at DATETIME NULL,
  speed_ingested_at DATETIME NULL,
  KEY idx_project_id (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per prediction run (the table keeps its historical "cofold" name):
-- a batch of complexes - bait-candidate pairs, pairs of one list, or single
-- homo-oligomers - each predicted by its own Slurm job running AlphaPulldown's
-- run_multimer_jobs.py (see backend/services/cofoldPlan.js). max_parallel
-- snapshots how many of them may be in flight at once; the other columns
-- snapshot the AlphaFold 3 options asked for so the run's speed samples stay
-- correct if the defaults change later. method/hardware are the labels the
-- run's samples are filed under.
CREATE TABLE IF NOT EXISTS alphapulldown_cofold_runs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  project_id BIGINT NOT NULL,
  owner_id BIGINT NOT NULL,
  total INT NOT NULL,
  max_parallel INT NOT NULL,
  -- --num_seeds, --num_diffusion_samples and --num_recycles of AlphaFold 3.
  model_seeds INT NOT NULL DEFAULT 1,
  diffusion_samples INT NOT NULL DEFAULT 5,
  num_recycles INT NOT NULL DEFAULT 10,
  gpu_count INT NOT NULL DEFAULT 1,
  method VARCHAR(50) NOT NULL DEFAULT '',
  hardware VARCHAR(100) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  cancelled_at DATETIME NULL,
  KEY idx_project_id (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per complex of a prediction run. bait_name/cand_name are the
-- project's own protein names (cand_name is NULL for a homo-oligomer, which
-- folds one protein alone, and equals bait_name for the A+A pair of
-- all-versus-all); they live here and never in the speed samples. state is
-- QUEUED (not submitted yet), SUBMITTING, SUBMIT_FAILED, or - once the Slurm
-- job exists - Slurm's own state words. slurm_job_id is the id the Slurm
-- module answered with; the job's own folder is predictions/run-<run_id>/job-<id>
-- under the project folder. speed_ingested_at is the private-side marker that
-- this pair's timings were copied (anonymised) into alphapulldown_speed_samples.
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
  slurm_job_id VARCHAR(40) NULL,
  claimed_at DATETIME NULL,
  checked_at DATETIME NULL,
  slurm_submitted_at DATETIME NULL,
  started_at DATETIME NULL,
  ended_at DATETIME NULL,
  speed_ingested_at DATETIME NULL,
  -- The scores of the best-ranked model, read once from AlphaFold 3's
  -- <fold>_summary_confidences.json when the job completed (see
  -- backend/services/foldResults.js), so the Results tab can sort and filter in
  -- SQL. scored_at is set once that has been tried; NULL scores with scored_at
  -- set mean no summary file was found. interface_pae_min is the lowest PAE
  -- between two different chains; has_clash is 0/1.
  iptm DOUBLE NULL,
  ptm DOUBLE NULL,
  ranking_score DOUBLE NULL,
  interface_pae_min DOUBLE NULL,
  has_clash TINYINT(1) NULL,
  scored_at DATETIME NULL,
  KEY idx_run_state (run_id, state),
  KEY idx_project_pair (project_id, bait_name, cand_name),
  KEY idx_project_scored (project_id, scored_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Anonymised speed samples: how long one feature search or one prediction job
-- took for a given size on given hardware. Shared by every user of this
-- module and used to estimate future runs; each finished job adds one row.
-- Deliberately holds NO owner, project, job, accession, protein name,
-- sequence or timestamp finer than a day - only sizes, a method label, a
-- hardware label, timings and an outcome. The link between a private job
-- and the sample it produced lives only on the private side (the
-- speed_ingested_at column on the feature run and prediction item rows), so a sample cannot be traced back to anyone. There is
-- intentionally no route that lets a client write here: rows come only from
-- backend/services/speedRecorder.js, from jobs this module itself observed.
-- stage: 'msa' (one protein's feature search, len_b NULL) or 'fold' (one
-- complex of one or two proteins, total_len = all chains together).
-- method: short label of what was run (e.g. 'af3' for the feature stage,
-- 'af3-s1-d5-r10' for a prediction); hardware: short label of where (e.g.
-- 'partition/8cpu').
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
