// Runs one feature's check on each post when it appears and a few times after, because
// Facebook fills a post's header in after drawing the post. check(element) returns true once
// it's done with that post (hidden, or nothing left to wait for), which stops the retries.

const RETRIES = [300, 1200, 3000];

export function watchPostChecks({ posts, enabled, check, retries = RETRIES, schedule = setTimeout, cancel = clearTimeout }) {
  const timers = new Map();
  const done = new WeakSet();

  function forget(element) {
    for (const timer of timers.get(element) ?? []) cancel(timer);
    timers.delete(element);
    done.delete(element);
  }

  function run(element) {
    if (!enabled() || done.has(element) || !element.isConnected) return;
    if (!check(element)) return;
    done.add(element);
    for (const timer of timers.get(element) ?? []) cancel(timer);
    timers.delete(element);
  }

  function track({ element }) {
    forget(element);
    timers.set(element, retries.map((delay) => schedule(() => {
      timers.get(element)?.shift();
      run(element);
    }, delay)));
    run(element);
  }

  const stops = [
    posts.on('post/add', track),
    posts.on('post/update', ({ element }) => run(element)),
    posts.on('post/remove', ({ element }) => forget(element)),
  ];

  return {
    // A fresh look at every post, after the switch comes back on.
    recheckAll() {
      for (const post of posts.current()) track(post);
    },
    stop() {
      for (const stop of stops) stop();
      for (const element of [...timers.keys()]) forget(element);
    },
  };
}
