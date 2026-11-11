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
  let pushing = false;

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
    setStatus("syncing");
    try {
      const local = hooks.getStore ? hooks.getStore() : null;
      const cloud = await fetchCloud(session.user.id);
      const firstSync = isFirstSyncFor(session.user.id);
      if (firstSync) await backupIfNeeded();
      const decision = Logic.choose(local, cloud, { firstSync });
      if (decision.source === "cloud") {
        if (hooks.setStore) await hooks.setStore(cloud.data, cloud.updated_at, { fromCloud: true });
        markSynced(session.user.id);
        setStatus("synced");
        return cloud.data;
      }
      if (local) {
        const stamped = local.updatedAt ? local : Logic.stamp(local);
        if (!local.updatedAt && hooks.setStore) {
          await hooks.setStore(stamped, stamped.updatedAt, { fromCloud: false, silent: true });
        }
        await upsertCloud(stamped);
      }
      setStatus("synced");
      return local;
    } catch (err) {
      pending = true;
      setStatus(isOffline() ? "offline" : "error", err);
      return null;
    }
  }

  async function push(store) {
    const session = await currentSession();
    if (!session || !store) return { ok: false, reason: session ? "empty" : "signed-out" };
    pending = true;
    if (pushing) return { ok: true, deferred: true };
    pushing = true;
    try {
      if (isOffline()) {
        setStatus("offline");
        return { ok: false, reason: "offline" };
      }
      setStatus("syncing");
      await upsertCloud(store);
      setStatus("synced");
      return { ok: true };
    } catch (err) {
      setStatus(isOffline() ? "offline" : "error", err);
      return { ok: false, error: err };
    } finally {
      pushing = false;
    }
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
          const local = hooks.getStore ? hooks.getStore() : null;
          const decision = Logic.choose(local, { data: row.data, updated_at: row.updated_at }, { firstSync: false });
          if (decision.source === "cloud" && hooks.setStore) {
            hooks.setStore(row.data, row.updated_at, { fromCloud: true });
          }
          setStatus("synced");
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
