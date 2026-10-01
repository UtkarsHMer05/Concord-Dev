// User edits, not engine operations. ASCII keeps PM offsets identical for both engines.
export const cells = ['append', 'middle', 'paste', 'delete', 'format', 'contested', 'independent', 'offline'];

export function workload(cell, quick = false) {
  if (!cells.includes(cell)) throw new Error(`Unknown workload: ${cell}`);
  const initialChars = quick ? 128 : cell === 'offline' ? 10000 : 2048;
  const initialText = 'A shared engineering proposal. '.repeat(Math.ceil(initialChars / 31)).slice(0, initialChars);
  const count = quick ? 4 : cell === 'offline' ? 250 : cell === 'paste' ? 4 : 40;
  const clients = cell === 'contested' ? (quick ? 2 : 4) : cell === 'independent' ? (quick ? 2 : 8) : 2;
  const writers = ['contested', 'independent'].includes(cell) ? clients : 1;
  const edits = Array.from({ length: writers }, (_, writer) => Array.from({ length: count }, (_, step) => {
    if (cell === 'format') return { kind: 'format', from: 1 + (step % 8) * 12, to: 9 + (step % 8) * 12, mark: step % 2 ? 'italic' : 'bold' };
    if (cell === 'delete') return { kind: 'delete', from: 5, to: 7 };
    const text = cell === 'paste' ? 'Large paste with retained edits. '.repeat(quick ? 8 : 128) :
      cell === 'contested' ? `[${writer}:${step}]` : cell === 'offline' ? String.fromCharCode(97 + step % 26) : 'x';
    return { kind: 'insert', at: ['middle', 'contested'].includes(cell) ? 32 : 'end', text };
  }));
  return { cell, initialText, clients, documents: cell === 'independent' ? clients : 1, edits };
}

// This function is also serialized directly into the real production browser.
export function applyEditorEdit(editor, edit) {
  if (edit === undefined) {
    edit = editor; editor = document.querySelector('.ProseMirror').editor;
    if (globalThis.liveBench) { globalThis.liveBench.start = performance.now(); globalThis.liveBench.painted = new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - globalThis.liveBench.start)))); }
  }
  if (edit.kind === 'insert') return editor.commands.insertContentAt(edit.at === 'end' ? editor.state.doc.content.size - 1 : edit.at, { type: 'text', text: edit.text });
  if (edit.kind === 'delete') return editor.commands.deleteRange({ from: edit.from, to: edit.to });
  return editor.chain().setTextSelection({ from: edit.from, to: edit.to })[edit.mark === 'bold' ? 'toggleBold' : 'toggleItalic']().run();
}

export function canonicalDocument(doc) {
  if (doc.type !== 'doc' || !Array.isArray(doc.content)) throw new Error('Expected a PM document');
  return doc.content.map(block => {
    if (block.type !== 'paragraph') throw new Error(`Outside the shared subset: ${block.type}`);
    const chars = [];
    for (const run of block.content || []) {
      if (run.type !== 'text') throw new Error(`Outside the shared subset: ${run.type}`);
      const marks = (run.marks || []).map(mark => mark.type).sort();
      if (marks.some(mark => !['bold', 'italic'].includes(mark))) throw new Error('Outside the shared mark subset');
      chars.push(...[...run.text].map(text => ({ text, marks })));
    }
    return chars;
  });
}

export function expectedDocument(plan) {
  if (plan.cell === 'contested') return null; // Concurrent tie order is engine-specific; tokens and peer convergence are checked.
  return plan.edits.map(edits => {
    const chars = [...plan.initialText].map(text => ({ text, marks: [] }));
    for (const edit of edits) {
      if (edit.kind === 'insert') chars.splice(edit.at === 'end' ? chars.length : edit.at - 1, 0, ...[...edit.text].map(text => ({ text, marks: [] })));
      else if (edit.kind === 'delete') chars.splice(edit.from - 1, edit.to - edit.from);
      else for (let i = edit.from - 1; i < edit.to - 1; i++) {
        const marks = chars[i].marks;
        if (marks.includes(edit.mark)) chars[i].marks = marks.filter(mark => mark !== edit.mark);
        else chars[i].marks = [...marks, edit.mark].sort();
      }
    }
    return [chars];
  });
}

export function distribution(values) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('A metric needs finite nonnegative samples');
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { samples: sorted.length, min: sorted[0], p50: at(.5), p95: at(.95), max: sorted.at(-1) };
}
