// The "Add to cart" bookmarklet. The plan page makes a `javascript:` link of this file (storeCart.ts), the owner
// bookmarks it once, and runs it on a UniFi store page. It reads a plan, tops the store's cart up to it, and goes to the cart.
//
// It is self-contained on purpose: the store's CSP would stop a loader or a call to this server, so everything it needs is
// here and the plan reaches it in the page's #rr=... fragment (or the clipboard, or a paste). Nothing is sent anywhere but
// the store's own cart API, with the visitor's own cookies. Comment lines and indentation are stripped when it is made into
// a link, so every statement ends in ';' and no line holds a trailing // comment.
//
// What it depends on in the store (all found by watching the store's own "Add to Cart"; see DESIGN.md, "Adding a plan to the
// store's cart", for what to look at when the store changes and this stops working):
//   1. window.__APOLLO_CLIENT__, whose cache holds an ActiveCheckout record { id, secret, storeId }, and the
//      StorefrontCheckout record with the language the store speaks.
//   2. POST https://ecomm.svc.ui.com/graphql, with mutation storefrontUpdateCheckout(input: { id, secret, language,
//      updateItems: [{ storeProductVariantId, quantity }] }). The quantity is a change, not a total (-1 removes one).
//   3. query storefrontCheckout(input: { id, secret, language }), for what the cart holds now.
//   4. The cart is at /<region>/<language>/cart.
//
// Bump VERSION (and PLAN_FORMAT in storeCart.ts, if the payload changed) when this changes in a way an old bookmark can't follow.
(async () => {
  const VERSION = 1;
  const API = 'https://ecomm.svc.ui.com/graphql';
  const ITEM = '{ sku quantity variant { id } }';
  const READ = 'query RR($input: StorefrontCheckoutInput!) { storefrontCheckout(input: $input) { checkout { ... on StorefrontCheckout { items ' + ITEM + ' } } } }';
  const WRITE = 'mutation RR($input: StorefrontUpdateCheckoutInput!) { storefrontUpdateCheckout(input: $input) { checkout { ... on StorefrontCheckout { items ' + ITEM + ' } } } }';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const say = (text) => alert('Restock Radar\n\n' + text);
  // Where a test can see the page being left (jsdom can't leave one).
  const go = (path) => (window.__rrGo ? window.__rrGo(path) : (location.href = path));
  if (window.__rrCart) {
    return { status: 'busy' };
  }
  window.__rrCart = true;
  let toast = null;
  const progress = (text) => {
    if (!toast) {
      toast = document.createElement('div');
      toast.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;padding:10px 14px;border-radius:8px;background:#111;color:#fff;font:14px/1.3 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4)';
      document.body.appendChild(toast);
    }
    toast.textContent = 'Restock Radar: ' + text;
  };
  try {
    // The plan: the fragment the plan page opened this page with, else the clipboard, else whatever is pasted.
    const parse = (text) => {
      let plan;
      try {
        plan = JSON.parse(text);
      } catch (e) {
        return null;
      }
      if (!plan || typeof plan !== 'object' || !Array.isArray(plan.i)) {
        return null;
      }
      if (plan.v > VERSION) {
        return { stale: true };
      }
      const items = [];
      for (const row of plan.i) {
        if (!Array.isArray(row) || !UUID.test(row[0]) || !Number.isInteger(row[2]) || row[2] < 1 || row[2] > 99) {
          return null;
        }
        items.push({ id: row[0].toLowerCase(), sku: String(row[1]).slice(0, 80), qty: row[2] });
      }
      return items.length > 0 ? { name: String(plan.n || '').slice(0, 80), region: typeof plan.r === 'string' ? plan.r : '', items } : null;
    };
    let plan = null;
    const hash = /[#&]rr=([^&]*)/.exec(location.hash);
    if (hash) {
      try {
        plan = parse(decodeURIComponent(hash[1]));
      } catch (e) {
        plan = null;
      }
    }
    if (!plan) {
      try {
        plan = parse(await navigator.clipboard.readText());
      } catch (e) {
        plan = null;
      }
    }
    if (!plan) {
      plan = parse(prompt('Paste the plan from Restock Radar ("Add to UniFi cart" on the plan page):') || '');
    }
    if (!plan) {
      say('There is no plan to add. Open the plan page, choose "Add to UniFi cart", and use its button to open the store.');
      return { status: 'no-plan' };
    }
    if (plan.stale) {
      say('This bookmark is older than the plan page. Drag a fresh copy of the link from the plan page\'s "Add to UniFi cart" window over it.');
      return { status: 'stale' };
    }

    // Ids belong to one store, so a plan for another region's store is refused before anything is touched. The first part of
    // the path is the region ("us", "eu"), as it is in the plan. A plan that names none (an older page) isn't checked.
    const here = location.pathname.split('/');
    if (plan.region && plan.region !== here[1]) {
      say('This plan is for the ' + plan.region.toUpperCase() + ' store, but you are on the ' + (here[1] || '?').toUpperCase() + ' store. Open the plan\'s store from the plan page (its "Open the store" button for ' + plan.region.toUpperCase() + '), then run this again. Nothing was added.');
      return { status: 'wrong-store' };
    }

    // The cart the store is using for this visitor (it makes one when something is first added).
    const client = window.__APOLLO_CLIENT__;
    const cache = client && client.cache ? client.cache.extract() : {};
    const active = Object.values(cache).find((v) => v && v.__typename === 'ActiveCheckout');
    if (!active) {
      say('The store has no cart open yet. Add any one item to your cart here, then run this again; it adds the rest.');
      return { status: 'no-cart' };
    }
    const record = cache['StorefrontCheckout:' + active.id];
    const language = (record && record.language && record.language.locale) || here[2] || 'en';
    const call = async (query, input) => {
      const res = await fetch(API, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables: { input: Object.assign({ id: active.id, secret: active.secret, language, skipTaxCalculation: true }, input) } }),
      });
      const body = await res.json();
      if (body.errors && body.errors.length) {
        throw new Error(body.errors[0].message);
      }
      const data = body.data.storefrontUpdateCheckout || body.data.storefrontCheckout;
      return data.checkout.items;
    };
    const held = (items) => {
      const out = {};
      for (const it of items) {
        out[it.variant.id.toLowerCase()] = it.quantity;
      }
      return out;
    };

    // Top the cart up to the plan, so running this twice doesn't double anything.
    let have = held(await call(READ, {}));
    const todo = [];
    const already = [];
    for (const it of plan.items) {
      const need = it.qty - (have[it.id] || 0);
      if (need > 0) {
        todo.push({ id: it.id, sku: it.sku, need, qty: it.qty });
      } else {
        already.push(it);
      }
    }
    const units = todo.reduce((n, it) => n + it.need, 0);
    if (todo.length === 0) {
      say('Everything in the plan is already in your cart.');
      go('/' + here[1] + '/' + here[2] + '/cart');
      return { status: 'already' };
    }
    const lines = todo.map((it) => '  ' + it.need + ' × ' + it.sku + (it.need < it.qty ? ' (' + (it.qty - it.need) + ' already in the cart)' : '')).join('\n');
    if (!confirm('Add ' + units + (units === 1 ? ' item' : ' items') + (plan.name ? ' from "' + plan.name + '"' : '') + ' to your cart?\n\n' + lines + (already.length ? '\n\n' + already.length + ' more already there.' : ''))) {
      return { status: 'cancelled' };
    }
    const failed = [];
    let done = 0;
    for (const it of todo) {
      progress('adding ' + (done + failed.length + 1) + ' of ' + todo.length + '…');
      try {
        have = held(await call(WRITE, { updateItems: [{ storeProductVariantId: it.id, quantity: it.need }] }));
        done += 1;
      } catch (e) {
        failed.push(it.sku + ': ' + (e && e.message ? e.message : e));
      }
    }
    if (failed.length) {
      say('Added ' + done + ' of ' + todo.length + '. These were refused by the store (sold out, or not sold in this region?):\n\n' + failed.join('\n'));
    }
    progress('done, opening your cart…');
    go('/' + here[1] + '/' + here[2] + '/cart');
    return { status: failed.length ? 'partial' : 'ok', added: done, failed };
  } catch (e) {
    say('Something went wrong, so nothing more was added:\n\n' + (e && e.message ? e.message : e) + '\n\nThe store may have changed; the plan page has a newer bookmark if this has been fixed.');
    return { status: 'error', message: String(e && e.message ? e.message : e) };
  } finally {
    window.__rrCart = false;
    if (toast) {
      setTimeout(() => toast.remove(), 4000);
    }
  }
})()
