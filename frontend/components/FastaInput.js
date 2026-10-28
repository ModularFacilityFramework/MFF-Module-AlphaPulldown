// Add proteins from FASTA text: pasted into the box, or read from a file.
// The text is cut into requests of at most CHUNK_CHARS at record
// boundaries, so a large file never has to fit in one request body; the
// backend does the real parsing and validation.
import React, { useState } from 'react';
import styles from '../styles/SequencesTab.module.css';

const CHUNK_CHARS = 60000;

function chunkFasta(text) {
  const records = [];
  let current = [];
  text.split(/\r?\n/).forEach(line => {
    if (line.startsWith('>') && current.length > 0) {
      records.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  });
  if (current.length > 0) records.push(current.join('\n'));

  const chunks = [];
  let chunk = '';
  records.forEach(record => {
    if (chunk && chunk.length + record.length + 1 > CHUNK_CHARS) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += `${chunk ? '\n' : ''}${record}`;
  });
  if (chunk.trim()) chunks.push(chunk);
  return chunks;
}

function FastaInput({ onAdd, adding, targetLabel }) {
  const [text, setText] = useState('');
  const [file, setFile] = useState(null); // { name, size, text }
  const [error, setError] = useState('');

  const source = file ? file.text : text;
  const records = (source.match(/^>/gm) || []).length;

  function pickFile(e) {
    const chosen = e.target.files && e.target.files[0];
    if (!chosen) return;
    setError('');
    chosen.text()
      .then(content => setFile({ name: chosen.name, size: chosen.size, text: content }))
      .catch(err => setError(`Could not read the file: ${err.message}`));
  }

  function clearFile() {
    setFile(null);
  }

  function add() {
    onAdd(chunkFasta(source).map(chunk => ({ source: 'paste', text: chunk })))
      .then(() => { setText(''); setFile(null); });
  }

  return (
    <div>
      <p className={styles.hint}>
        Paste FASTA, or choose a file. The first word of each header becomes the protein&apos;s name (a UniProt
        <span className={styles.mono}> sp|P12345|NAME_HUMAN </span> header becomes <span className={styles.mono}>P12345</span>);
        text without a header is added as <span className={styles.mono}>sequence_1</span>.
      </p>
      {file ? (
        <div className={styles.controls}>
          <span>{`${file.name} (${(file.size / 1024).toFixed(0)} KB)`}</span>
          <button type="button" className={styles.btnGray} onClick={clearFile}>Remove file</button>
        </div>
      ) : (
        <textarea
          className={styles.textarea}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={'>P78344\nMESAIAEGGASRFSASSGGGGSRGAPQHYP...'}
          spellCheck={false}
        />
      )}
      <div className={styles.controls}>
        {!file && <input type="file" accept=".fa,.fasta,.faa,.txt" onChange={pickFile} />}
        <button type="button" className={styles.btnGreen} onClick={add} disabled={adding || !source.trim()}>
          {adding ? 'Adding...' : `Add ${records > 0 ? records.toLocaleString() : ''} ${records === 1 ? 'sequence' : 'sequences'} ${targetLabel}`}
        </button>
      </div>
      {error && <p className={styles.errorText}>{error}</p>}
    </div>
  );
}

export default FastaInput;
