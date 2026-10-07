// The runner container returns its results on stdout as length-prefixed frames, so the backend never opens a
// host path that the user's program could have replaced with a symlink/FIFO (see docs/DECISIONS.md D-016):
//   \x01CVIS <name> <emittedBytes> <originalBytes>\n<emittedBytes of data>
// The program shares the container with run.sh, so frames are untrusted like everything else it can write.
const MARKER = Buffer.from("\u0001CVIS ", "latin1");
const MAX_HEADER_BYTES = 80;
const HEADER = /^([a-z.]{1,20}) (\d{1,9}) (\d{1,9})$/;

/**
 * @param {Buffer} buffer  raw container stdout
 * @param {Set<string>} allowedNames  frames with other names are ignored
 * @returns {Map<string, { text: string, truncated: boolean }>}  the first frame of each allowed name wins
 */
function parseFrames(buffer, allowedNames) {
  const frames = new Map();
  let offset = buffer.indexOf(MARKER);
  while (offset !== -1) {
    const headerStart = offset + MARKER.length;
    const newline = buffer.indexOf(0x0a, headerStart);
    const match = newline === -1 || newline - headerStart > MAX_HEADER_BYTES
      ? null
      : HEADER.exec(buffer.toString("latin1", headerStart, newline));
    if (!match) {
      offset = buffer.indexOf(MARKER, headerStart); // stray bytes: resynchronise on the next marker
      continue;
    }
    const [, name, emitted, original] = match;
    const dataStart = newline + 1;
    const dataEnd = dataStart + Number(emitted);
    if (dataEnd > buffer.length) break;
    if (allowedNames.has(name) && !frames.has(name)) {
      frames.set(name, { text: buffer.toString("utf8", dataStart, dataEnd), truncated: Number(original) > Number(emitted) });
    }
    offset = buffer.indexOf(MARKER, dataEnd);
  }
  return frames;
}

module.exports = { parseFrames };
