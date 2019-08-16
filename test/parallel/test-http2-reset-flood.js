'use strict';
const common = require('../common');
if (!common.hasCrypto)
  common.skip('missing crypto');

const http2 = require('http2');
const net = require('net');
const { Worker, parentPort } = require('worker_threads');

// Verify that creating a number of invalid HTTP/2 streams will eventually
// result in the peer closing the session.
// This test uses separate threads for client and server to avoid
// the two event loops intermixing, as we are writing in a busy loop here.

if (process.env.HAS_STARTED_WORKER) {
  const server = http2.createServer();
  server.on('stream', (stream) => {
    stream.respond({
      'content-type': 'text/plain',
      ':status': 200
    });
    stream.end('Hello, world!\n');
  });
  server.listen(0, () => parentPort.postMessage(server.address().port));
  return;
}

process.env.HAS_STARTED_WORKER = 1;
const worker = new Worker(__filename).on('message', common.mustCall((port) => {
  const h2header = Buffer.alloc(9);
  const conn = net.connect(port);

  conn.write('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');

  h2header[3] = 4;  // Send a settings frame.
  conn.write(Buffer.from(h2header));

  let inbuf = Buffer.alloc(0);
  let state = 'settingsHeader';
  let settingsFrameLength;
  conn.on('data', (chunk) => {
    inbuf = Buffer.concat([inbuf, chunk]);
    switch (state) {
      case 'settingsHeader':
        if (inbuf.length < 9) return;
        settingsFrameLength = inbuf.readIntBE(0, 3);
        inbuf = inbuf.slice(9);
        state = 'readingSettings';
        // Fallthrough
      case 'readingSettings':
        if (inbuf.length < settingsFrameLength) return;
        inbuf = inbuf.slice(settingsFrameLength);
        h2header[3] = 4;  // Send a settings ACK.
        h2header[4] = 1;
        conn.write(Buffer.from(h2header));
        state = 'ignoreInput';
        writeRequests();
    }
  });

  let gotError = false;

  function writeRequests() {
    for (let i = 1; !gotError; i += 2) {
      h2header[3] = 1;  // HEADERS
      h2header[4] = 0x5;  // END_HEADERS|END_STREAM
      h2header.writeIntBE(1, 0, 3);  // Length: 1
      h2header.writeIntBE(i, 5, 4);  // Stream ID
      // 0x88 = :status: 200
      conn.write(Buffer.concat([h2header, Buffer.from([0x88])]));
    }
  }

  conn.once('error', common.mustCall(() => {
    gotError = true;
    worker.terminate();
    conn.destroy();
  }));
}));