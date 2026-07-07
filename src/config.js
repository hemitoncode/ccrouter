'use strict';

// Configuration loading: bundled defaults merged with the user's global
// overrides. Defaults ship inside the package (config.default.json, resolved
// relative to this file so it works from a global `npm i -g` install). User
// overrides live in ~/.cc-model-router/config.json and deep-merge over the
// defaults. CCROUTER_HOME overrides the state dir (used by tests).

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config.default.json');

const TIER_ORDER = { low: 0, mid: 1, high: 2 };

function stateDir() {
  return process.env.CCROUTER_HOME || path.join(os.homedir(), '.cc-model-router');
}

function userConfigPath() {
  return path.join(stateDir(), 'config.json');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Minimal shape check for the keys the server dereferences at runtime.
function validate(cfg) {
  const models = cfg.models;
  if (!isObject(models) ||
      !['low', 'mid', 'high'].every((t) => typeof models[t] === 'string' && models[t])) {
    return 'models must be an object with low/mid/high model-id strings';
  }
  if (!Number.isInteger(cfg.port)) return 'port must be an integer';
  if (typeof cfg.sentinel !== 'string' || !cfg.sentinel) {
    return 'sentinel must be a non-empty string';
  }
  if (!isObject(cfg.rules) || !isObject(cfg.keywords)) {
    return 'rules/keywords must be objects';
  }
  return null;
}

function loadConfig(userPath) {
  // Parse the defaults fresh each call so callers can mutate freely.
  const defaults = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
  const target = userPath !== undefined ? userPath : userConfigPath();

  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      defaults._user_config_loaded = null;
      return defaults;
    }
    defaults._user_config_loaded = null;
    defaults._user_config_error = `${target}: ${err.message}`;
    return defaults;
  }

  try {
    const userCfg = JSON.parse(raw);
    if (!isObject(userCfg)) throw new Error('top-level config must be a JSON object');
    const merged = deepMerge(defaults, userCfg);
    const problem = validate(merged);
    if (problem) throw new Error(problem);
    merged._user_config_loaded = String(target);
    return merged;
  } catch (err) {
    // A broken user config must never take the proxy down: fall back to the
    // pristine defaults and surface the problem via health/doctor.
    const fresh = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
    fresh._user_config_loaded = null;
    fresh._user_config_error = `${target}: ${err.message}`;
    return fresh;
  }
}

function maxTier(a, b) {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b;
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  TIER_ORDER,
  stateDir,
  userConfigPath,
  loadConfig,
  maxTier,
};
