// The real medication list Meds has to handle, as dose patterns: every dose, slot and weekday
// exactly as prescribed. This repo is public, so the names default to neutral labels. To run
// the same tests with the real names, put them in tests/private/names.json (gitignored):
//   { "splitA": "...", "splitB": "...", "weekday": "...", "breakfastOnly": "...", "twiceSame": "...", "prn": "..." }
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_NAMES = {
  splitA: 'Split-dose A',        // 200 mg breakfast, 600 mg dinner
  splitB: 'Split-dose B',        // 50 mg breakfast, 25 mg dinner
  weekday: 'Weekday-dose',       // dinner only: 8 mg Thu and Sun, 6 mg other days
  breakfastOnly: 'Breakfast-only', // 81 mg breakfast
  twiceSame: 'Twice-daily',      // 300 mg breakfast and 300 mg dinner
  prn: 'As-needed',              // 50 mg, PRN
};

function names() {
  try {
    return { ...DEFAULT_NAMES, ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'private', 'names.json'), 'utf8')) };
  } catch (e) {
    return DEFAULT_NAMES;
  }
}

//                        Sun     Mon     Tue     Wed     Thu     Fri     Sat
const WEEKDAY_DOSES = ['8 mg', '6 mg', '6 mg', '6 mg', '8 mg', '6 mg', '6 mg'];

// Form-style input for each med, in list order.
function medInputs(n = names()) {
  return [
    { key: 'splitA', id: 'splitA', name: n.splitA, doses: { morning: '200 mg', evening: '600 mg' } },
    { key: 'splitB', id: 'splitB', name: n.splitB, doses: { morning: '50 mg', evening: '25 mg' } },
    { key: 'weekday', id: 'weekday', name: n.weekday, doses: { morning: null, evening: WEEKDAY_DOSES } },
    { key: 'breakfastOnly', id: 'breakfastOnly', name: n.breakfastOnly, doses: { morning: '81 mg', evening: null } },
    { key: 'twiceSame', id: 'twiceSame', name: n.twiceSame, doses: { morning: '300 mg', evening: '300 mg' } },
    { key: 'prn', id: 'prn', name: n.prn, prn: true, dose: '50 mg' },
  ];
}

// The list as a Meds state, entered on `enteredOn` (all versions apply from the start).
function medListState(core, enteredOn = new Date('2026-09-26T16:00:00Z')) {
  const today = core.dayKeyOf(enteredOn);
  const meds = medInputs().map((m, i) => core.newMed(m.id, m, i, today, enteredOn));
  return core.migrate({ meds, logs: {}, settings: {} });
}

module.exports = { names, medInputs, medListState, WEEKDAY_DOSES };
