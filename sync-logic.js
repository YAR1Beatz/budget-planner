(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BudgetSyncLogic = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function stamp(store, now) {
    const when =
      now instanceof Date ? now.toISOString() : typeof now === "string" && now ? now : new Date().toISOString();
    return { ...store, updatedAt: when };
  }

  function timeOf(value) {
    if (!value) return 0;
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : 0;
  }

  function substanceScore(store) {
    if (!store || !Array.isArray(store.profiles)) return 0;
    let score = 0;
    store.profiles.forEach((profile) => {
      score += 1;
      const data = profile && profile.data;
      if (!data) return;
      if (Array.isArray(data.goals)) score += data.goals.length * 2;
      if (Array.isArray(data.loans)) score += data.loans.length * 2;
      const months = data.months && typeof data.months === "object" ? data.months : {};
      Object.keys(months).forEach((key) => {
        const month = months[key] || {};
        const income = Array.isArray(month.income) ? month.income : [];
        const expenses = Array.isArray(month.expenses) ? month.expenses : [];
        income.concat(expenses).forEach((row) => {
          const amount = Number(String((row && row.amount) || "0").replace(",", "."));
          if (amount) score += 3;
        });
      });
    });
    return score;
  }

  function choose(localStore, cloudRow, opts) {
    if (!cloudRow || cloudRow.data == null) {
      return { source: "local", reason: "cloud-empty" };
    }
    const localTime = timeOf(localStore && localStore.updatedAt);
    const cloudTime = timeOf(cloudRow.updated_at);
    const firstSync = !!(opts && opts.firstSync);
    if (firstSync) {
      const localScore = substanceScore(localStore);
      const cloudScore = substanceScore(cloudRow.data);
      if (localScore > 0 && localScore > cloudScore) {
        return { source: "local", reason: "first-sync-keep-local" };
      }
    }
    if (cloudTime > localTime) return { source: "cloud", reason: "cloud-newer" };
    return { source: "local", reason: cloudTime === localTime ? "tie-keep-local" : "local-newer" };
  }

  function cleanName(name) {
    return String(name || "").trim().replace(/\s+/g, " ").slice(0, 60);
  }

  function uidOf(profile) {
    if (profile && typeof profile.uid === "string" && profile.uid) return profile.uid;
    return "legacy:" + String(profile && profile.id) + ":" + cleanName(profile && profile.name).toLowerCase();
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
    if (value && typeof value === "object") {
      return (
        "{" +
        Object.keys(value)
          .sort()
          .map((key) => JSON.stringify(key) + ":" + stableStringify(value[key]))
          .join(",") +
        "}"
      );
    }
    return JSON.stringify(value === undefined ? null : value);
  }

  // Per-device view state. Never synced between devices and never used to
  // decide which copy of a budget is newer.
  const UI_FIELDS = ["activeTab", "selectedMonth"];

  function withoutUi(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return data;
    const copy = {};
    Object.keys(data).forEach((key) => {
      if (UI_FIELDS.indexOf(key) === -1) copy[key] = data[key];
    });
    return copy;
  }

  function keepLocalUi(winnerData, localData) {
    if (!winnerData || !localData) return winnerData;
    const out = { ...winnerData };
    if (localData.activeTab) out.activeTab = localData.activeTab;
    const months = out.months && typeof out.months === "object" ? out.months : {};
    if (localData.selectedMonth && months[localData.selectedMonth]) out.selectedMonth = localData.selectedMonth;
    return out;
  }

  function hasAmount(row) {
    return !!Number(String((row && row.amount) || "0").replace(",", "."));
  }

  // A profile nobody has typed into: no amounts, goals or loans.
  function isBlankProfile(profile) {
    const data = profile && profile.data;
    if (!data) return true;
    if (Array.isArray(data.goals) && data.goals.length) return false;
    if (Array.isArray(data.loans) && data.loans.length) return false;
    const months = data.months && typeof data.months === "object" ? data.months : {};
    return !Object.keys(months).some((key) => {
      const month = months[key] || {};
      const rows = [].concat(month.income || [], month.expenses || []);
      return rows.some(hasAmount);
    });
  }

  // The untouched "My budget" a fresh install creates. Dropped when the other
  // side has real budgets, so signing in on a new device does not add clutter.
  function isFreshPlaceholder(store) {
    const profiles = (store && Array.isArray(store.profiles) && store.profiles) || [];
    return profiles.length === 1 && cleanName(profiles[0].name) === "My budget" && isBlankProfile(profiles[0]);
  }

  function profileTime(profile, store, fallback) {
    return timeOf(profile && profile.updatedAt) || timeOf(store && store.updatedAt) || timeOf(fallback);
  }

  function signature(store, fallbackTime) {
    const profiles = ((store && store.profiles) || []).map((p) => ({
      uid: uidOf(p),
      name: p.name,
      at: profileTime(p, store, fallbackTime),
      data: withoutUi(p.data),
    }));
    profiles.sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
    const tombs = ((store && store.deletedProfiles) || []).map((t) => t.uid + "@" + t.at).sort();
    return stableStringify({ profiles, tombs });
  }

  function nextId(used) {
    let max = 0;
    used.forEach((id) => {
      const match = String(id).match(/^p(\d+)$/);
      if (match) max = Math.max(max, Number(match[1]));
    });
    return "p" + (max + 1);
  }

  function monthStamp(month) {
    return timeOf(month && month.updatedAt);
  }

  function readDeletedMonths(data) {
    const raw = data && data.deletedMonths && typeof data.deletedMonths === "object" ? data.deletedMonths : {};
    const out = {};
    Object.keys(raw).forEach((key) => {
      if (timeOf(raw[key])) out[key] = raw[key];
    });
    return out;
  }

  // Union months from both copies. A deleted month stays gone unless it was
  // explicitly created again after the tombstone (month.updatedAt is newer).
  // Months without their own timestamp cannot beat a tombstone, so a later
  // edit to a *different* month on the other device does not bring it back.
  function mergeMonthState(localData, cloudData, localTime, cloudTime) {
    const localMonths = (localData && localData.months && typeof localData.months === "object") ? localData.months : {};
    const cloudMonths = (cloudData && cloudData.months && typeof cloudData.months === "object") ? cloudData.months : {};
    const localTombs = readDeletedMonths(localData);
    const cloudTombs = readDeletedMonths(cloudData);
    const tombs = { ...cloudTombs };
    Object.keys(localTombs).forEach((key) => {
      if (timeOf(localTombs[key]) >= timeOf(tombs[key])) tombs[key] = localTombs[key];
    });
    const keys = Array.from(new Set([].concat(Object.keys(localMonths), Object.keys(cloudMonths), Object.keys(tombs))));
    const months = {};
    const deletedMonths = {};
    keys.forEach((key) => {
      const localMonth = localMonths[key];
      const cloudMonth = cloudMonths[key];
      const localStamp = monthStamp(localMonth);
      const cloudStamp = monthStamp(cloudMonth);
      // Only an explicit per-month time can beat a tombstone. Falling back to
      // the profile time would let a later edit of a different month restore it.
      const liveStamp = Math.max(localStamp, cloudStamp);
      const tomb = timeOf(tombs[key]);
      if (tomb && tomb >= liveStamp) {
        deletedMonths[key] = tombs[key];
        return;
      }
      if (localMonth && cloudMonth) {
        // localTime / cloudTime are already millisecond timestamps from profileTime.
        const localProfile = typeof localTime === "number" ? localTime : timeOf(localTime);
        const cloudProfile = typeof cloudTime === "number" ? cloudTime : timeOf(cloudTime);
        if (cloudStamp !== localStamp) {
          months[key] = cloudStamp > localStamp ? cloudMonth : localMonth;
        } else if (cloudProfile !== localProfile) {
          months[key] = cloudProfile > localProfile ? cloudMonth : localMonth;
        } else {
          months[key] = stableStringify(cloudMonth) > stableStringify(localMonth) ? cloudMonth : localMonth;
        }
      } else {
        months[key] = localMonth || cloudMonth;
      }
    });
    return { months, deletedMonths };
  }

  function withMergedMonths(winnerData, localData, cloudData, localTime, cloudTime) {
    const merged = mergeMonthState(localData, cloudData, localTime, cloudTime);
    const data = { ...(winnerData || {}) };
    data.months = merged.months;
    if (Object.keys(merged.deletedMonths).length) data.deletedMonths = merged.deletedMonths;
    else delete data.deletedMonths;
    return data;
  }

  // Merge two stores budget by budget. Every budget on either side is kept;
  // when both sides have the same budget the most recently edited copy wins.
  // A budget is only removed when it was deleted after its last edit.
  function merge(localStore, cloudStore, cloudUpdatedAt) {
    const local = localStore && Array.isArray(localStore.profiles) ? localStore : null;
    const cloud = cloudStore && Array.isArray(cloudStore.profiles) ? cloudStore : null;
    if (!cloud) return { store: local, localChanged: false, cloudChanged: !!local, reason: "cloud-empty" };
    if (!local) return { store: cloud, localChanged: true, cloudChanged: false, reason: "local-empty" };

    const dropLocal = isFreshPlaceholder(local) && !isFreshPlaceholder(cloud);
    const dropCloud = isFreshPlaceholder(cloud) && !isFreshPlaceholder(local);

    const tombs = {};
    [].concat(local.deletedProfiles || [], cloud.deletedProfiles || []).forEach((t) => {
      if (!t || !t.uid) return;
      if (!tombs[t.uid] || timeOf(t.at) > timeOf(tombs[t.uid])) tombs[t.uid] = t.at;
    });

    const cloudByUid = {};
    (dropCloud ? [] : cloud.profiles).forEach((p) => {
      cloudByUid[uidOf(p)] = p;
    });

    const out = [];
    const used = new Set();
    const seen = new Set();

    function keep(profile, time) {
      const uid = uidOf(profile);
      if (tombs[uid] && timeOf(tombs[uid]) >= time) return;
      let id = profile.id != null ? String(profile.id) : "";
      if (!id || used.has(id)) id = nextId(used);
      used.add(id);
      const next = { ...profile, id, uid };
      if (time) next.updatedAt = new Date(time).toISOString();
      out.push(next);
    }

    (dropLocal ? [] : local.profiles).forEach((lp) => {
      const uid = uidOf(lp);
      seen.add(uid);
      const cp = cloudByUid[uid];
      const lt = profileTime(lp, local);
      if (!cp) return keep(lp, lt);
      const ct = profileTime(cp, cloud, cloudUpdatedAt);
      let winner = lp;
      let time = lt;
      const cloudContent = stableStringify([cp.name, withoutUi(cp.data)]);
      const localContent = stableStringify([lp.name, withoutUi(lp.data)]);
      if (cloudContent !== localContent) {
        if (ct > lt) {
          winner = { ...cp, id: lp.id };
          time = ct;
        } else if (ct === lt && cloudContent > localContent) {
          // Same timestamp, different content: pick deterministically so both devices agree.
          winner = { ...cp, id: lp.id };
        }
      } else {
        time = Math.max(lt, ct);
      }
      // Months are merged with tombstones so a deleted month is not restored
      // by a later edit to a different month on the other device. Goals, loans
      // and the rest of the budget still follow the newest profile edit.
      // The tab and month this device is looking at always stay this device's.
      winner = { ...winner, data: keepLocalUi(withMergedMonths(winner.data, lp.data, cp.data, lt, ct), lp.data) };
      keep(winner, time);
    });

    (dropCloud ? [] : cloud.profiles).forEach((cp) => {
      const uid = uidOf(cp);
      if (seen.has(uid)) return;
      seen.add(uid);
      keep(cp, profileTime(cp, cloud, cloudUpdatedAt));
    });

    if (!out.length) {
      // Never end up with nothing: fall back to whichever side had budgets.
      const fallback = local.profiles.length ? local : cloud;
      return { store: fallback, localChanged: fallback !== local, cloudChanged: fallback !== cloud, reason: "empty-merge" };
    }

    const activeProfileId = out.some((p) => p.id === String(local.activeProfileId))
      ? String(local.activeProfileId)
      : out[0].id;
    const latest = Math.max(timeOf(local.updatedAt), timeOf(cloud.updatedAt), timeOf(cloudUpdatedAt));
    const merged = {
      ...local,
      version: Math.max(Number(local.version) || 2, Number(cloud.version) || 2),
      profiles: out,
      activeProfileId,
    };
    if (latest) merged.updatedAt = new Date(latest).toISOString();
    const tombList = Object.keys(tombs).map((uid) => ({ uid, at: tombs[uid] }));
    if (tombList.length) merged.deletedProfiles = tombList.slice(-50);
    else delete merged.deletedProfiles;

    const sig = signature(merged);
    return {
      store: merged,
      localChanged: sig !== signature(local),
      cloudChanged: sig !== signature(cloud, cloudUpdatedAt),
      reason: "merged",
    };
  }

  return { UI_FIELDS, withoutUi, stamp, timeOf, substanceScore, choose, merge, mergeMonthState, uidOf, isBlankProfile, isFreshPlaceholder, signature };
});
