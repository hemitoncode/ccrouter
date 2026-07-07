#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli');

main(process.argv.slice(2))
  .then((code) => process.exit(typeof code === 'number' ? code : 0))
  .catch((err) => {
    process.stderr.write('ccrouter: ' + (err && err.stack ? err.stack : err) + '\n');
    process.exit(1);
  });
