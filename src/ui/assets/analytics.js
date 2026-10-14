/* biome-ignore-all lint: the loader below is PostHog's published snippet, kept verbatim. */
/* biome-ignore-all format: same. */
// What a person does on the wiki, reported to PostHog: page views, a task copied for their agent,
// an experience seen (the events are sent from app.js through window.posthog). The page only loads
// this file when the operator set POSTHOG_KEY (config.ts), and says where to report in two body
// attributes; the loader fetches PostHog's library from that host, which the page's CSP allows.
// Nothing here runs, and nothing is fetched from anywhere, on a wiki without a key.
//
// Loader: https://posthog.com/docs/libraries/js (the snippet, unchanged).
const { phKey: key, phHost: host, name, view, slug, tag, base = "" } = document.body.dataset;
if (key && host) {
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],Object.defineProperty(u,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e}}),Object.defineProperty(u.people,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(){return u.toString(1)+".people (stub)"}}),o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  // The handle a key here signs as, when the browser holds one (app.js keeps it under this name).
  let handle = null;
  try {
    handle = JSON.parse(localStorage.getItem(`ow.key:${base}`) ?? "null")?.handle ?? null;
  } catch {
    handle = null;
  }
  // Every event from this page says which view of the wiki it happened on. Added per event, not
  // registered: a registered property would persist to the next page of the site around the wiki.
  const here = { wiki: name, wiki_view: view, wiki_slug: slug ?? null, wiki_tag: tag ?? null, wiki_handle: handle };
  posthog.init(key, {
    api_host: host,
    // Explicit, not the `defaults` bundle: each page is a full load, so the first pageview is the only one.
    capture_pageview: true,
    capture_pageleave: true,
    // No person profile until someone is identified, which this wiki never does: readers stay anonymous.
    person_profiles: "identified_only",
    before_send: (event) => {
      if (event) event.properties = { ...event.properties, ...here };
      return event;
    },
  });
}
