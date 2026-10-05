// Site selectors/state adapted from the two Apache-2.0 upstream projects.
// These fixed expressions run only inside service-owned tabs; never model-supplied JS.
const unwrap = x => x?.value ?? x?._value ?? x;
const initial = () => window.__INITIAL_STATE__ || {};
const visible = selector => [...document.querySelectorAll(selector)].some(e => e.getBoundingClientRect().width > 0);
const loginSignals = () => {
  const s = initial(), info = unwrap(s.user?.userInfo);
  const challenge = visible('.r-captcha-modal, .captcha-container, #captcha-container');
  return {logged_in: !!info && info.guest === false && !!(info.userId || info.user_id),
    challenge, login_visible: visible('.login-container'), ready: !!s.user};
};
const feedState = kind => {
  const s = initial();
  if (kind === 'feed') return unwrap(s.feed?.feeds) || [];
  if (kind === 'search') return unwrap(s.search?.feeds) || [];
  const lists = unwrap(s.user?.notes) || [];
  return Array.isArray(lists[0]) ? lists[0] : lists;
};
const detailState = id => unwrap(initial().note?.noteDetailMap)?.[id] || null;
const profileState = () => unwrap(initial().user?.userPageData) || null;
