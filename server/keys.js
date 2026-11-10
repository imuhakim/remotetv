'use strict';
// One brand-neutral key vocabulary used by the UI. Each driver maps these
// names to its own protocol codes and reports which ones it supports.
const KEYS = [
  'up', 'down', 'left', 'right', 'ok', 'back', 'home', 'menu', 'apps',
  'vol_up', 'vol_down', 'mute', 'ch_up', 'ch_down',
  'power', 'power_off', 'input', 'info', 'guide', 'settings', 'search',
  'play', 'pause', 'play_pause', 'stop', 'rewind', 'forward', 'prev', 'next',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'red', 'green', 'yellow', 'blue',
];

module.exports = { KEYS };
