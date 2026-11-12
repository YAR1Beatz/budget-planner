(function (root) {
  "use strict";

  const Logic = root.BudgetSyncLogic;
  const config = root.BUDGET_SUPABASE || {};
  const FIRST_SYNC_KEY = "budget-planner-synced-user";

  let client = null;
  let channel = null;
  let hooks = {};
  let status = "signed-out";
  let user = null;
  let lastError = null;
  let pending = false;

  function emit() {
    if (hooks.onChange) hooks.onChange(getStatus());
  }

  function setStatus(next, err) {
    status = next;
    lastError = err ? String(err.message || err) : null;
    emit();
  }

  function getStatus() {
    return { status, user, error: lastError, pending };
  }

  function getClient() {
    if (client) return client;
    if (!root.supabase || typeof root.supabase.createClient !== "function") return null;
    if (!config.url || !config.key) return null;
    client = root.supabase.createClient(config.url, config.key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
    return client;
  }

  function isFirstSyncFor(userId) {
    try {
      return window.localStorage.getItem(FIRST_SYNC_KEY) !== userId;
    } catch (err) {
      return true;
    }
  }

  function markSynced(userId) {
    try {
      window.localStorage.setItem(FIRST_SYNC_KEY, userId);
    } catch (err) {}
  }

  async function currentSession() {
    const sb = getClient();
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data && data.session ? data.session : null;
  }

  async function backupIfNeeded() {
    if (hooks.backupLocal) {
      try {
        await hooks.backupLocal();
      } catch (err) {}
    }
  }

  async function fetchCloud(userId) {
    const sb = getClient();
    const { data, error } = await sb
      .from("budget_store")
      .select("data, updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function upsertCloud(store) {
    const sb = getClient();
    const session = await currentSession();
    if (!session) throw new Error("Not signed in");
    const updatedAt = store.updatedAt || new Date().toISOString();
    const { error } = await sb.from("budget_store").upsert(
      {
        user_id: session.user.id,
        data: store,
        updated_at: updatedAt,
      },
      { onConflict: "user_id" }
    );
    if (error) throw error;
    markSynced(session.user.id);
    pending = false;
    return updatedAt;
  }

  function isOffline() {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }

  // Fetch the cloud copy, merge it budget by budget with this device's copy,
  // apply the result here and upload it if the cloud is missing anything.
  // Nothing is ever replaced wholesale, so no budget is dropped by syncing.
  let syncing = null;
  let again = false;

  async function syncOnce(session) {
    const cloud = await fetchCloud(session.user.id);
    if (isFirstSyncFor(session.user.id)) await backupIfNeeded();
    // Read this device's copy only now, after the network wait, so edits made
    // while the request was in flight are part of the merge.
    const local = hooks.getStore ? hooks.getStore() : null;
    if (!cloud || cloud.data == null) {
      if (local) await upsertCloud(local.updatedAt ? local : Logic.stamp(local));
      return local;
    }
    const result = Logic.merge(local, cloud.data, cloud.updated_at);
    let merged = result.store;
    if (result.cloudChanged && merged) {
      merged = Logic.stamp(merged);
      await upsertCloud(merged);
    } else {
      markSynced(session.user.id);
      pending = false;
    }
    if (result.localChanged && merged && hooks.setStore) {
      // Something changed here while we were uploading: never apply a merge
      // built from an older copy of this device. Run another round instead.
      const now = hooks.getStore ? hooks.getStore() : null;
      if (now !== local) {
        again = true;
        return merged;
      }
      await hooks.setStore(merged, merged.updatedAt, { fromCloud: true });
    }
    return merged;
  }

  async function reconcile() {
    const session = await currentSession();
    if (!session) {
      user = null;
      setStatus("signed-out");
      return null;
    }
    user = session.user;
    if (isOffline()) {
      pending = true;
      setStatus("offline");
      return null;
    }
    if (syncing) {
      again = true;
      return syncing;
    }
    setStatus("syncing");
    syncing = (async () => {
      let out = null;
      try {
        do {
          again = false;
          out = await syncOnce(session);
        } while (again);
        setStatus("synced");
      } catch (err) {
        pending = true;
        setStatus(isOffline() ? "offline" : "error", err);
        out = null;
      }
      return out;
    })();
    try {
      return await syncing;
    } finally {
      syncing = null;
    }
  }

  async function push(store) {
    const session = await currentSession();
    if (!session || !store) return { ok: false, reason: session ? "empty" : "signed-out" };
    pending = true;
    if (isOffline()) {
      setStatus("offline");
      return { ok: false, reason: "offline" };
    }
    const out = await reconcile();
    return out ? { ok: true } : { ok: false, reason: status };
  }

  function subscribeRealtime() {
    const sb = getClient();
    if (!sb || channel) return;
    channel = sb
      .channel("budget_store_sync")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "budget_store" },
        (payload) => {
          const row = payload.new;
          if (!row || !user || row.user_id !== user.id) return;
          if (syncing) {
            // A sync round is running; it will pick this up.
            again = true;
            return;
          }
          const local = hooks.getStore ? hooks.getStore() : null;
          const result = Logic.merge(local, row.data, row.updated_at);
          if (result.localChanged && result.store && hooks.setStore) {
            hooks.setStore(result.store, result.store.updatedAt, { fromCloud: true });
          }
          if (result.cloudChanged) reconcile();
          else setStatus("synced");
        }
      )
      .subscribe();
  }

  function unsubscribe() {
    const sb = getClient();
    if (sb && channel) {
      sb.removeChannel(channel);
      channel = null;
    }
  }

  async function afterAuth() {
    subscribeRealtime();
    return reconcile();
  }

  const api = {
    confirmationRequired: true,
    init(nextHooks) {
      hooks = nextHooks || {};
      const sb = getClient();
      if (!sb) {
        setStatus("signed-out");
        return;
      }
      sb.auth.onAuthStateChange(async (event, session) => {
        user = session ? session.user : null;
        if (!session) {
          unsubscribe();
          setStatus("signed-out");
          return;
        }
        if (event === "TOKEN_REFRESHED" && status === "synced") {
          emit();
          return;
        }
        if (event === "SIGNED_IN" || event === "INITIAL_SESSION" || event === "USER_UPDATED") {
          await afterAuth();
        }
      });
      if (typeof window !== "undefined") {
        window.addEventListener("online", async () => {
          if (pending || status === "offline" || status === "error") await reconcile();
        });
        window.addEventListener("offline", () => {
          if (user) setStatus("offline");
        });
        window.addEventListener("focus", async () => {
          if (user) await reconcile();
        });
        document.addEventListener("visibilitychange", async () => {
          if (document.visibilityState === "visible" && user) await reconcile();
        });
      }
    },
    async signIn(email, password) {
      const sb = getClient();
      if (!sb) throw new Error("Sync is not available.");
      const { data, error } = await sb.auth.signInWithPassword({ email: String(email || "").trim(), password });
      if (error) throw error;
      return data;
    },
    async signUp(email, password) {
      const sb = getClient();
      if (!sb) throw new Error("Sync is not available.");
      const { data, error } = await sb.auth.signUp({ email: String(email || "").trim(), password });
      if (error) throw error;
      return data;
    },
    async signOut() {
      const sb = getClient();
      unsubscribe();
      if (sb) await sb.auth.signOut();
      user = null;
      setStatus("signed-out");
    },
    push,
    pull: reconcile,
    getStatus,
  };

  root.BudgetSync = api;
})(typeof window !== "undefined" ? window : this);
