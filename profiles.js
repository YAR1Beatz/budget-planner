(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./defaults"));
  } else {
    root.BudgetProfiles = factory(root.BudgetDefaults);
  }
})(typeof self !== "undefined" ? self : this, function (Defaults) {
  "use strict";

  const STORE_VERSION = 2;
  const BACKUP_SUFFIX = "budget-data.backup-before-profiles.json";

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function isStore(raw) {
    return isPlainObject(raw) && Array.isArray(raw.profiles);
  }

  function isLegacyState(raw) {
    if (!isPlainObject(raw) || isStore(raw)) return false;
    return (
      isPlainObject(raw.months) ||
      raw.currency != null ||
      Array.isArray(raw.goals) ||
      Array.isArray(raw.loans)
    );
  }

  function nextProfileId(profiles) {
    let max = 0;
    (profiles || []).forEach((profile) => {
      const match = String(profile && profile.id).match(/^p(\d+)$/);
      if (match) max = Math.max(max, Number(match[1]));
    });
    return "p" + (max + 1);
  }

  function cleanName(name) {
    return String(name || "").trim().replace(/\s+/g, " ").slice(0, 60);
  }

  // Stable identity used by sync to match the same budget across devices.
  // Older profiles get a deterministic uid from their id + name, so two
  // devices holding the same legacy profile agree without talking first.
  function legacyUid(id, name) {
    return "legacy:" + String(id) + ":" + cleanName(name).toLowerCase();
  }

  function newUid() {
    return "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function isoNow(now) {
    if (now instanceof Date) return now.toISOString();
    if (typeof now === "string" && now) return now;
    return new Date().toISOString();
  }

  const UI_FIELDS = ["activeTab", "selectedMonth"];

  // Content of a profile that matters for "has this budget changed".
  function contentKey(data) {
    if (!isPlainObject(data)) return JSON.stringify(data == null ? null : data);
    const copy = {};
    Object.keys(data)
      .filter((key) => UI_FIELDS.indexOf(key) === -1)
      .sort()
      .forEach((key) => {
        copy[key] = data[key];
      });
    return JSON.stringify(copy);
  }

  function emptyStore(opts, now) {
    const name = cleanName(opts && opts.name) || "My budget";
    const id = "p1";
    return {
      version: STORE_VERSION,
      profiles: [{ id, name, data: Defaults.freshState(now) }],
      activeProfileId: id,
    };
  }

  function migrateFromLegacy(raw, opts, now) {
    const name = cleanName(opts && opts.name) || "Morten";
    const id = "p1";
    return {
      version: STORE_VERSION,
      profiles: [{ id, name, data: Defaults.normalizeState(raw, now) }],
      activeProfileId: id,
    };
  }

  function normalizeStore(raw, now) {
    if (!isStore(raw)) {
      if (isLegacyState(raw)) return migrateFromLegacy(raw, { name: "Morten" }, now);
      return emptyStore({ name: "My budget" }, now);
    }

    const used = new Set();
    const profiles = [];
    raw.profiles.forEach((item, index) => {
      if (!isPlainObject(item)) return;
      let id = item.id != null && String(item.id).trim() ? String(item.id) : nextProfileId(profiles);
      if (used.has(id)) id = nextProfileId(profiles.concat([{ id }]));
      used.add(id);
      const name = cleanName(item.name) || "Budget " + (index + 1);
      const profile = {
        id,
        uid: typeof item.uid === "string" && item.uid.trim() ? item.uid.trim() : legacyUid(id, name),
        name,
        data: Defaults.normalizeState(item.data, now),
      };
      if (typeof item.updatedAt === "string" && item.updatedAt.trim()) profile.updatedAt = item.updatedAt.trim();
      profiles.push(profile);
    });

    if (!profiles.length) return emptyStore({ name: "My budget" }, now);

    let activeProfileId = raw.activeProfileId != null ? String(raw.activeProfileId) : profiles[0].id;
    if (!profiles.some((profile) => profile.id === activeProfileId)) {
      activeProfileId = profiles[0].id;
    }

    const store = {
      version: STORE_VERSION,
      profiles,
      activeProfileId,
    };
    if (typeof raw.updatedAt === "string" && raw.updatedAt.trim()) {
      store.updatedAt = raw.updatedAt.trim();
    }
    if (Array.isArray(raw.deletedProfiles)) {
      const tombs = raw.deletedProfiles
        .filter((t) => isPlainObject(t) && typeof t.uid === "string" && t.uid && typeof t.at === "string")
        .map((t) => ({ uid: t.uid, at: t.at }));
      if (tombs.length) store.deletedProfiles = tombs.slice(-50);
    }
    return store;
  }

  function openRaw(raw, opts, now) {
    const existingName = (opts && opts.existingName) || "Morten";
    const emptyName = (opts && opts.emptyName) || "My budget";
    if (raw == null) {
      return { store: emptyStore({ name: emptyName }, now), created: true, migrated: false };
    }
    if (isStore(raw)) {
      return { store: normalizeStore(raw, now), created: false, migrated: false };
    }
    if (isLegacyState(raw)) {
      return {
        store: migrateFromLegacy(raw, { name: existingName }, now),
        created: false,
        migrated: true,
      };
    }
    return { store: emptyStore({ name: emptyName }, now), created: true, migrated: false };
  }

  function backupPathFor(file) {
    if (typeof file !== "string") return BACKUP_SUFFIX;
    if (/budget-data\.json$/i.test(file)) {
      return file.replace(/budget-data\.json$/i, BACKUP_SUFFIX);
    }
    return file + ".backup-before-profiles.json";
  }

  function openFile(file, fs, opts, now) {
    if (!fs.existsSync(file)) {
      return {
        store: emptyStore({ name: (opts && opts.emptyName) || "My budget" }, now),
        created: true,
        migrated: false,
        backupPath: null,
      };
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const opened = openRaw(raw, opts, now);
    let backupPath = null;
    if (opened.migrated) {
      backupPath = backupPathFor(file);
      if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(file, backupPath);
      }
    }
    return { ...opened, backupPath };
  }

  function getActive(store) {
    if (!store || !Array.isArray(store.profiles)) return null;
    return store.profiles.find((profile) => profile.id === store.activeProfileId) || store.profiles[0] || null;
  }

  function withActiveData(store, data, now) {
    const active = getActive(store);
    if (!active) return store;
    const changed = contentKey(active.data) !== contentKey(data);
    const when = changed ? isoNow(now) : null;
    return {
      ...store,
      version: STORE_VERSION,
      profiles: store.profiles.map((profile) => {
        if (profile.id !== active.id) return profile;
        return changed ? { ...profile, data, updatedAt: when } : { ...profile, data };
      }),
    };
  }

  function setActive(store, id) {
    const target = store.profiles.find((profile) => String(profile.id) === String(id));
    if (!target) return { ok: false, error: "Could not find that budget.", store };
    if (store.activeProfileId === target.id) return { ok: true, store, changed: false };
    return {
      ok: true,
      changed: true,
      store: { ...store, activeProfileId: target.id },
    };
  }

  function addProfile(store, name, now) {
    const cleaned = cleanName(name);
    if (!cleaned) return { ok: false, error: "Enter a name for the budget.", store };
    const id = nextProfileId(store.profiles);
    const profile = { id, uid: newUid(), name: cleaned, data: Defaults.freshState(now), updatedAt: isoNow(now) };
    return {
      ok: true,
      store: {
        ...store,
        profiles: store.profiles.concat(profile),
        activeProfileId: id,
      },
      profile,
    };
  }

  function renameProfile(store, id, name, now) {
    const cleaned = cleanName(name);
    if (!cleaned) return { ok: false, error: "Enter a name for the budget.", store };
    if (!store.profiles.some((profile) => String(profile.id) === String(id))) {
      return { ok: false, error: "Could not find that budget.", store };
    }
    return {
      ok: true,
      store: {
        ...store,
        profiles: store.profiles.map((profile) =>
          String(profile.id) === String(id)
            ? { ...profile, uid: profile.uid || legacyUid(profile.id, profile.name), name: cleaned, updatedAt: isoNow(now) }
            : profile
        ),
      },
    };
  }

  function deleteProfile(store, id, now) {
    if (!store.profiles.some((profile) => String(profile.id) === String(id))) {
      return { ok: false, error: "Could not find that budget.", store };
    }
    if (store.profiles.length <= 1) {
      return { ok: false, error: "You need at least one budget.", store };
    }
    const gone = store.profiles.find((profile) => String(profile.id) === String(id));
    const profiles = store.profiles.filter((profile) => String(profile.id) !== String(id));
    const tomb = { uid: gone.uid || legacyUid(gone.id, gone.name), at: isoNow(now) };
    const deletedProfiles = (Array.isArray(store.deletedProfiles) ? store.deletedProfiles : []).concat(tomb).slice(-50);
    let activeProfileId = store.activeProfileId;
    if (String(activeProfileId) === String(id)) {
      activeProfileId = profiles[0].id;
    }
    return { ok: true, store: { ...store, profiles, activeProfileId, deletedProfiles } };
  }

  function counts(data) {
    const months = data && data.months && typeof data.months === "object" ? Object.keys(data.months).length : 0;
    const goals = data && Array.isArray(data.goals) ? data.goals.length : 0;
    const loans = data && Array.isArray(data.loans) ? data.loans.length : 0;
    return { months, goals, loans };
  }

  return {
    STORE_VERSION,
    BACKUP_SUFFIX,
    isStore,
    isLegacyState,
    nextProfileId,
    cleanName,
    legacyUid,
    contentKey,
    emptyStore,
    migrateFromLegacy,
    normalizeStore,
    openRaw,
    backupPathFor,
    openFile,
    getActive,
    withActiveData,
    setActive,
    addProfile,
    renameProfile,
    deleteProfile,
    counts,
  };
});
