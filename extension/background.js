const TARGET_SPEED = 500;

// Fire whenever a replay tab finishes loading
chrome.webNavigation.onCompleted.addListener(
  (details) => {
    if (details.frameId !== 0) return; // top frame only
    injectSpeed(details.tabId, TARGET_SPEED);
  },
  { url: [{ hostEquals: 'globe.adsbexchange.com', queryContains: 'replay=' }] }
);

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Clamp to the range of speeds the adsbexchange slider can produce
function clampSpeed(n) {
  return Math.max(0, Math.min(988, n));
}

async function injectSpeed(tabId, targetSpeed) {
  const speed = clampSpeed(targetSpeed);

  // Retry until the replay UI is ready (jQuery + slider elements may load async)
  for (let attempt = 0; attempt < 25; attempt++) {
    await delay(250);
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',  // needs jQuery access
        func: applyAdsbexchangeReplaySpeed,
        args: [speed],
      });
    } catch {
      return; // tab closed or navigated away
    }
    if (results?.[0]?.result?.ok) return;
  }
}

// Runs in the page's MAIN world so it can access jQuery.
// Binary searches the jQuery UI slider's internal [0–10] range to find
// the slider position that produces the closest displayed speed to target.
function applyAdsbexchangeReplaySpeed(targetSpeed) {
  const play = document.getElementById('replayPlay');
  const sliderEl = document.getElementById('replaySpeedSelect');
  const hint = document.getElementById('replaySpeedHint');

  if (!play || !sliderEl || !hint) return { ok: false };

  const $ = window.jQuery;
  if (!$) return { ok: false };

  const wasPlaying = play.classList.contains('active');

  function getDisplayedSpeed() {
    const m = (hint.textContent || '').match(/[\d.]+/);
    return m ? parseFloat(m[0]) : 0;
  }

  function fire(val) {
    const $s = $(sliderEl);
    $s.slider('value', val);
    // Use the widget's _trigger so adsbexchange's slide callback receives the
    // correct {handle, value} ui object and updates #replaySpeedHint synchronously.
    const inst = $s.data('ui-slider');
    if (inst) {
      const handle = $s.find('.ui-slider-handle')[0];
      inst._trigger('slide', null, { handle, value: val, values: [val] });
    }
  }

  // 18-iteration binary search over slider internal range [0, 10]
  let lo = 0, hi = 10;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    fire(mid);
    if (getDisplayedSpeed() < targetSpeed) lo = mid;
    else hi = mid;
  }
  fire((lo + hi) / 2);

  // Re-pause if the replay auto-started when speed was set — even 0.2 s at
  // 500x advances replay by ~100 seconds, so keep it paused.
  if (!wasPlaying && play.classList.contains('active')) {
    play.click();
  }

  return { ok: true };
}
