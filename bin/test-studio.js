#!/usr/bin/env node
// Starts Test Studio's headless runner. See `test-studio help`.
const path = require('path');
const { spawn } = require('child_process');

const electron = require('electron');
const args = [path.join(__dirname, '..'), '--ts-cli', ...process.argv.slice(2)];
// Chromium refuses to start as root without this (common in CI containers).
if (process.platform === 'linux' && process.getuid && process.getuid() === 0) args.unshift('--no-sandbox');

const child = spawn(electron, args, { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 2 : code == null ? 2 : code));
