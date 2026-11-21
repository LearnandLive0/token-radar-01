// tools/shot-check.mjs — pure gate functions for the B' detail screenshot.
//
// The gate answers: does the packaged detail image show a FARM row whose plan
// has real costs and 7+ visible steps? It runs on (a) the board.json row and
// (b) the live-DOM measurement taken from the same page load the screenshot
// comes from. No I/O here, so the tests can import these directly.
//
// Thresholds (V8 §二.1: every step has a numeric cost; zero-cost steps display
// $0.00, so a FARM/THIN plan has 7/7 $ costs and a SKIP plan has 7/7 $0.00):
// - The bar is dollar === steps: every plan step must carry a "$" cost.
//   A step without one fails, however many the others have.
// - The plan table always has 7 rows in B; the bar is >= 7 visible steps,
//   measured as the table's bottom edge inside the 1000px viewport.

export const DETAIL_GATE = {
  minSteps: 7,
  viewportHeight: 1000,
};

// Cost segment of a farm_steps text line: "... Amount: X. Cost: Y. Time: Z."
// Anchor on ". Time:" (not the first period) because costs contain decimals
// such as "$0.5 of gas"; fall back to the first period for lines without Time.
export function costOfStepText(text) {
  const m = /Cost: (.*?)\. Time:/.exec(text) || /Cost: ([^.]*)\./.exec(text);
  return m ? m[1].trim() : null;
}

export function checkDetailRow(row) {
  const failures = [];
  if (!row) {
    failures.push('row missing');
  } else {
    if (row.verdict !== 'FARM') failures.push('verdict is ' + row.verdict + ', not FARM');
    const steps = Array.isArray(row.farm_steps) ? row.farm_steps : [];
    if (steps.length < DETAIL_GATE.minSteps) {
      failures.push('farm_steps ' + steps.length + ' < ' + DETAIL_GATE.minSteps);
    }
    const dollar = steps.filter((s) => {
      const c = costOfStepText(String(s));
      return c !== null && c.indexOf('$') >= 0;
    }).length;
    if (dollar !== steps.length) {
      failures.push('$ cost steps ' + dollar + ' of ' + steps.length);
    }
  }
  return { ok: failures.length === 0, failures };
}

// m: the measurement object returned by Runtime.evaluate in the page.
// { dialogOpen, verdict, stepRows, dollarCosts, tableBottom, dialogScrollTop, arithPresent }
export function checkDetailDom(m) {
  const failures = [];
  if (!m) {
    failures.push('no DOM measurement');
  } else {
    if (!m.dialogOpen) failures.push('detail dialog not open');
    if (m.verdict !== 'FARM') {
      failures.push('dialog verdict is ' + JSON.stringify(m.verdict) + ', not FARM');
    }
    if (typeof m.stepRows !== 'number' || m.stepRows < DETAIL_GATE.minSteps) {
      failures.push('plan rows ' + m.stepRows + ' < ' + DETAIL_GATE.minSteps);
    }
    if (typeof m.dollarCosts !== 'number' || typeof m.stepRows !== 'number' || m.dollarCosts !== m.stepRows) {
      failures.push('$ cost cells ' + m.dollarCosts + ' of ' + m.stepRows);
    }
    if (typeof m.tableBottom !== 'number' || m.tableBottom > DETAIL_GATE.viewportHeight) {
      failures.push('plan table bottom ' + m.tableBottom + ' exceeds viewport ' + DETAIL_GATE.viewportHeight);
    }
    if (m.dialogScrollTop !== 0) {
      failures.push('dialog scrolled (scrollTop ' + m.dialogScrollTop + ')');
    }
    if (!m.arithPresent) failures.push('arithmetic bar missing');
  }
  return { ok: failures.length === 0, failures };
}
