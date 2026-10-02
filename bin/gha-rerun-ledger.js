#!/usr/bin/env node
'use strict';

const { LedgerError, main } = require('../lib/ledger');

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof LedgerError) process.stderr.write(`Error: ${error.message}\n`);
  else process.stderr.write('Error: operation failed.\n');
  process.exitCode = 2;
});
