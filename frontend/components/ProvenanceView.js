// One run's provenance record as readable text: the proteome versions and
// feature sets it used and, once the job has ended, the software and
// database versions the job itself recorded. Purely presentational.
import React from 'react';
import styles from '../styles/MsaTab.module.css';

function day(value) {
  return value ? String(value).slice(0, 10) : '';
}

function ProvenanceView({ record }) {
  if (!record) return null;
  const env = record.environment;
  return (
    <div className={styles.provenance}>
      <h4 className={styles.panelTitle}>What this run used</h4>
      {record.proteomes.length === 0 && <p className={styles.muted}>No library proteome: every protein is the user&apos;s own sequence.</p>}
      {record.proteomes.map(p => (
        <p key={`${p.proteomeId}-${p.featureSet ? p.featureSet.key : 'none'}`} className={styles.summary}>
          <strong>{`${p.organism} `}</strong>
          {`(${p.upid}, UniProt release ${p.release}${p.releaseDate ? ` of ${p.releaseDate}` : ''}, ${p.subset === 'reviewed' ? 'reviewed entries only' : 'all entries'}, ${p.proteins.toLocaleString()} protein${p.proteins === 1 ? '' : 's'} used; proteome SHA-256 ${String(p.sha256 || '').slice(0, 12)})`}
          {p.featureSet
            ? ` - feature set ${p.featureSet.key} (template cut-off ${p.featureSet.maxTemplateDate})`
            : ' - features not linked yet'}
        </p>
      ))}
      {record.proteins && record.proteins.local > 0 && (
        <p className={styles.summary}>{`${record.proteins.local.toLocaleString()} protein${record.proteins.local === 1 ? '' : 's'} from the user's own sequences (features kept in the project).`}</p>
      )}
      {env ? (
        <p className={styles.summary}>
          {`Software: AlphaPulldown ${env.software.alphapulldown}, AlphaFold 3 ${env.software.alphafold3 || 'not found'}, JAX ${env.software.jax || '?'}, Python ${env.software.python} (recorded ${day(env.capturedAt)} on ${env.host}). `}
          {`Databases: ${env.databases.map(d => `${d.name} (${d.modified})`).join('; ')}.`}
        </p>
      ) : (
        record.kind === 'features' && <p className={styles.muted}>The software and database versions are recorded by the job itself and shown here once it has ended.</p>
      )}
    </div>
  );
}

export default ProvenanceView;
