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

-- One row per user, upserted from the Setup tab. Holds AlphaPulldown's OWN
-- resource request outright: default_partition/default_cpus_per_task/
-- default_mem/default_time are this module's own settings for what an
-- AlphaPulldown job actually needs to run (matching a real, known-working
-- reference script for this cluster - njp158's pyp1_abcfold.slurm), not
-- something dependent on an admin having configured anything on the
-- Slurm module's side. The GRES request is computed at job-creation time
-- from the requested GPU count (gpu:<count>), and the partition actually
-- used is cross-checked against backend/services/slurmClient.js's
-- listGpuPartitions() (live cluster detection, no admin config needed -
-- see docs/MFF-Module-SLURM_slurm-config.md), falling back to
-- default_partition only if that detection comes back empty. account/email
-- both come straight from coreApi at request time (req.user.username,
-- coreApi.listUsers() for email), and each job's output directory comes
-- from coreApi.getUserWorkspacePath(req.user) - neither is cached in this
-- module's own table. If that workspace isn't active for a user (see
-- alphapulldownRoutes.js's POST /jobs and /jobs/:id/submit), this module
-- refuses to create or submit jobs for them at all.
CREATE TABLE IF NOT EXISTS alphapulldown_settings (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  owner_id BIGINT NOT NULL,
  slurm_mail_type VARCHAR(50) NOT NULL DEFAULT 'BEGIN,END,FAIL',
  -- 'micromamba' or 'conda' - which environment manager activates env_name
  -- in the generated sbatch script. Not an ENUM: this file has no
  -- migrations, ever, and a free-form default is easier to extend later.
  env_manager VARCHAR(20) NOT NULL DEFAULT 'micromamba',
  env_name VARCHAR(255) NOT NULL DEFAULT 'abcfold',
  -- Matches a real, known-working reference script for this cluster
  -- (njp158's pyp1_abcfold.slurm).
  default_partition VARCHAR(100) NOT NULL DEFAULT 'gpu',
  default_cpus_per_task INT NOT NULL DEFAULT 8,
  default_mem VARCHAR(20) NOT NULL DEFAULT '64G',
  default_time VARCHAR(20) NOT NULL DEFAULT '24:00:00',
  -- Real local database on this cluster (full AlphaFold3 bundle:
  -- uniref90/uniref30/bfd/mgnify/pdb70/pdb_seqres/pdb_mmcif/uniprot/
  -- params) - an available alternative to --mmseqs2 below, not the
  -- default; see alphapulldownRoutes.js's DEFAULT_SETTINGS for why.
  default_database_dir VARCHAR(500) NOT NULL DEFAULT '/home/linuxhomes/software/genetic_db',
  -- Matches njp158's own known-working reference script - real, proven
  -- working on this cluster.
  default_mmseqs2 TINYINT(1) NOT NULL DEFAULT 1,
  default_templates TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_owner_id (owner_id)
  -- No FK to setup_users(id) here on purpose: this module's own schema
  -- shouldn't be tightly coupled to core's internal table structure.
  -- owner_id is validated at the application layer (req.user.id, from
  -- coreApi.authenticateToken) instead.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per created job draft. Structured columns for cheap list
-- rendering; the generated AF3 input JSON, abcfold CLI command, and sbatch
-- script are stored as full text snapshots. status starts 'draft' and, once
-- submitted (POST /jobs/:id/submit), tracks the Slurm module's own state
-- vocabulary verbatim (PENDING/RUNNING/COMPLETED/FAILED/CANCELLED/etc,
-- refreshed on every GET /jobs/:id/status poll) - see
-- backend/services/slurmClient.js.
CREATE TABLE IF NOT EXISTS alphapulldown_jobs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  owner_id BIGINT NOT NULL,
  -- Per-owner sequential number (1, 2, 3, ...) - NOT the same as id, which
  -- is global across every user. Shown to the user as "J<job_number>" and
  -- used to name that job's own workDir under the user's workspace
  -- (see alphapulldownRoutes.js's POST /jobs: MAX(job_number)+1 for this owner_id).
  -- DEFAULT 0 exists only so mff-core's schema-diffing ADD COLUMN can add
  -- this column to an already-populated table (it refuses a NOT NULL
  -- column with no DEFAULT on a non-empty table, on purpose - see
  -- docs/MFF-Core_module-database-provisioning.md's "Schema diffing"
  -- section) - every row inserted through this module's own code always
  -- supplies a real value explicitly, this default is never relied on
  -- going forward. Pre-existing rows backfilled this way all read job_number=0
  -- ("J0") until a real admin decides they're worth renumbering by hand -
  -- schema diffing only adds columns, never backfills meaningful values.
  job_number INT NOT NULL DEFAULT 0,
  name VARCHAR(255) NOT NULL,
  -- Free-form, not ENUM: this file has no migrations, ever, and the Slurm
  -- module owns this vocabulary, not this module.
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  -- NULL until POST /jobs/:id/submit succeeds - the Slurm module's own job
  -- identifier, needed for every status/files/download call after that.
  slurm_job_id VARCHAR(100) NULL,
  models_selected VARCHAR(100) NOT NULL,
  -- This job's workDir - an absolute, on-disk path under the user's core
  -- workspace (coreApi.getUserWorkspacePath). Not created until
  -- POST /jobs/:id/submit actually writes submit.sh + the input JSON here
  -- (a plain draft has no files on disk yet) and hands this same path to
  -- the Slurm module, which requires it to already exist with those files
  -- in place - the Slurm module never creates, writes into, or reads any
  -- directory itself (docs/MFF-Module-SLURM_slurm-config.md). This module
  -- also reads its own file listing/downloads straight back off this path,
  -- since the Slurm module provides no route for that anymore either.
  output_dir VARCHAR(500) NOT NULL,
  input_json_filename VARCHAR(255) NOT NULL,
  input_json LONGTEXT NOT NULL,
  abcfold_command TEXT NOT NULL,
  sbatch_script LONGTEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_owner_id (owner_id),
  UNIQUE KEY uniq_owner_job_number (owner_id, job_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Which roles can see which of this module's tabs (Page Access tab, staff
-- only). A page with no rows here is invisible to non-staff users - staff
-- (canManageUsers) always see every tab regardless of this table's content.
CREATE TABLE IF NOT EXISTS alphapulldown_page_access (
  page_key VARCHAR(100) NOT NULL,
  role VARCHAR(50) NOT NULL,
  PRIMARY KEY (page_key, role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
