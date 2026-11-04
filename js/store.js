// Rooms and settings, kept in this browser. Every key starts with "sweep.".

import { defaultUnits } from './units.js';

const INDEX = 'sweep.v1.rooms';
const ROOM = id => `sweep.v1.room.${id}`;
const SETTINGS = 'sweep.v1.settings';

export const DEFAULTS = {
  units: defaultUnits(),
  seconds: 3, // how long a look lasts
  countdown: 3, // seconds to get out of the way before a look
  straighten: true,
  correction: 1, // distance correction from a tape measure
  method: 'auto', // auto, serial or usb
  points: false, // show the raw points under the plan
};

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    if (err && (err.name === 'QuotaExceededError' || err.code === 22)) throw new Error('full');
    return false;
  }
}

export function loadSettings() { return { ...DEFAULTS, ...read(SETTINGS, {}) }; }
export function saveSettings(s) { write(SETTINGS, s); }

export function listRooms() {
  const list = read(INDEX, []);
  return Array.isArray(list) ? list : [];
}

export function loadRoom(id) { return read(ROOM(id), null); }

// The full room goes under its own key; the list keeps a summary for the home screen.
export function saveRoom(room, summary) {
  write(ROOM(room.id), room);
  const list = listRooms().filter(r => r.id !== room.id);
  list.unshift({ id: room.id, name: room.name, updated: room.updated, ...summary });
  write(INDEX, list);
}

export function deleteRoom(id) {
  try { localStorage.removeItem(ROOM(id)); } catch { /* fine */ }
  write(INDEX, listRooms().filter(r => r.id !== id));
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
