//! Who may call what: the user's token, and the token of one session's tools.
use aura_core::*;
use aura_rpc::client::RpcClient;
use aura_rpc::server::RpcServer;
use serde_json::{json, Value};
use std::sync::Arc;

/// A manager with two feature owners and a plain orchestrator, restored from
/// the store so no agent runs.
fn sessions() -> (Manager, String, String, String) {
    let store = Arc::new(MemoryStore::default());
    let session = |title: &str, owner: bool| {
        let mut s = Session::new(&CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: "/tmp".into(),
            title: Some(title.into()),
            orchestrator: true,
            feature_owner: owner,
            ..Default::default()
        });
        s.status = SessionStatus::Idle;
        store.upsert_session(&s).unwrap();
        s.id
    };
    let (a, b, plain) = (
        session("A", true),
        session("B", true),
        session("Lead", false),
    );
    let m = Manager::new(store, vec![], None);
    m.restore().unwrap();
    (m, a, b, plain)
}

async fn err(c: &RpcClient, method: &str, params: Value) -> String {
    c.call(method, params)
        .await
        .expect_err(&format!("{method} must be refused"))
        .to_string()
}

#[tokio::test]
async fn the_users_token_does_not_act_as_a_feature_owner() {
    let (m, a, _b, _plain) = sessions();
    let dir = tempfile::tempdir().unwrap();
    let server = RpcServer::start(m.clone(), dir.path(), None).await.unwrap();
    let user = RpcClient::connect(server.info.port, &server.info.token)
        .await
        .unwrap();
    let e = err(
        &user,
        "owner.record_decision",
        json!({ "owner": a, "decision": "x", "rationale": "y" }),
    )
    .await;
    assert!(e.contains("session token"), "{e}");
    assert!(m.feature(&a).unwrap().decisions.is_empty());
    // The user's own calls still work.
    user.call("feature.get", json!({ "id": a })).await.unwrap();
}

#[tokio::test]
async fn a_sessions_token_acts_for_that_session_alone_and_never_as_the_user() {
    let (m, a, b, plain) = sessions();
    let dir = tempfile::tempdir().unwrap();
    let server = RpcServer::start(m.clone(), dir.path(), None).await.unwrap();
    let user = RpcClient::connect(server.info.port, &server.info.token)
        .await
        .unwrap();
    let owner_a = RpcClient::connect(server.info.port, &m.session_token(&a))
        .await
        .unwrap();

    // Its own owner's tools work.
    owner_a
        .call(
            "owner.record_decision",
            json!({ "owner": a, "decision": "x", "rationale": "y" }),
        )
        .await
        .unwrap();
    let q: UserQuestion = owner_a
        .call_as("owner.ask_user", json!({ "owner": a, "question": "Ship?" }))
        .await
        .unwrap();
    owner_a
        .call("orchestrator.workers", json!({ "orchestrator": a }))
        .await
        .unwrap();
    owner_a.call("provider.list", json!({})).await.unwrap();
    // Its own meetings and suggestion pass are its owner's tools too.
    let e = err(
        &owner_a,
        "owner.continue_meeting",
        json!({ "owner": a, "meeting": "m9", "steer": "go" }),
    )
    .await;
    assert!(e.contains("no meeting `m9`"), "{e}");
    owner_a
        .call("owner.suggest_specialists", json!({ "owner": a }))
        .await
        .unwrap();
    owner_a
        .call("orchestrator.projects", json!({}))
        .await
        .unwrap();

    // Not another owner's, and nothing that is the user's.
    for (method, params) in [
        (
            "owner.record_decision",
            json!({ "owner": b, "decision": "x", "rationale": "y" }),
        ),
        ("orchestrator.workers", json!({ "orchestrator": b })),
        (
            "feature.answer",
            json!({ "id": a, "question": q.id, "option": null, "text": "yes" }),
        ),
        (
            "feature.resolve_suggestion",
            json!({ "id": a, "suggestion": "s1", "accept": true }),
        ),
        ("feature.set_autonomy", json!({ "id": a, "autonomy": null })),
        (
            "feature.set_meeting_mode",
            json!({ "id": a, "mode": "live" }),
        ),
        (
            "meetings.set",
            json!({ "mode": "live", "max_rounds": 5, "turn_words": 400 }),
        ),
        ("suggestions.set_settings", json!({ "enabled": true })),
        ("suggestions.resolve", json!({ "id": "r1", "accept": true })),
        ("suggestions.run", json!({ "owner": a })),
        ("suggestions.list", json!({})),
        (
            "owner.close_meeting",
            json!({ "owner": b, "meeting": "m1", "outcome": "x" }),
        ),
        (
            "autonomy.set",
            json!({ "level": "autonomous", "checkpoints": [] }),
        ),
        (
            "specialists.save",
            json!({ "name": "x", "instructions": "y" }),
        ),
        ("settings.set", json!({ "key": "k", "value": "v" })),
        ("settings.get", json!({ "key": "k" })),
        ("session.list", json!({})),
        (
            "session.send",
            json!({ "id": a, "input": { "text": "hi" } }),
        ),
        ("daemon.info", json!({})),
        ("daemon.shutdown", json!({})),
    ] {
        let e = err(&owner_a, method, params).await;
        assert!(
            e.contains("may only use that session's own tools"),
            "{method}: {e}"
        );
    }
    assert!(m.feature(&b).unwrap().decisions.is_empty());
    assert!(
        m.feature(&a).unwrap().question(&q.id).unwrap().open(),
        "the owner cannot answer for the user"
    );

    // A plain orchestrator's tools keep working with its token, and get no owner's tools.
    let lead = RpcClient::connect(server.info.port, &m.session_token(&plain))
        .await
        .unwrap();
    lead.call("orchestrator.workers", json!({ "orchestrator": plain }))
        .await
        .unwrap();
    let e = err(
        &lead,
        "owner.record_decision",
        json!({ "owner": plain, "decision": "x", "rationale": "y" }),
    )
    .await;
    assert!(e.contains("not a feature owner"), "{e}");

    // The user answers.
    user.call(
        "feature.answer",
        json!({ "id": a, "question": q.id, "option": null, "text": "yes" }),
    )
    .await
    .unwrap();

    // A token nobody made is refused, and one goes with its session.
    assert!(RpcClient::connect(server.info.port, "s-made-up")
        .await
        .is_err());
    let token_b = m.session_token(&b);
    m.delete(&b, false).await.unwrap();
    assert!(RpcClient::connect(server.info.port, &token_b)
        .await
        .is_err());
}

#[tokio::test]
async fn a_sessions_token_hears_none_of_the_users_events() {
    let (m, a, _b, _plain) = sessions();
    let dir = tempfile::tempdir().unwrap();
    let server = RpcServer::start(m.clone(), dir.path(), None).await.unwrap();
    let user = RpcClient::connect(server.info.port, &server.info.token)
        .await
        .unwrap();
    let tools = RpcClient::connect(server.info.port, &m.session_token(&a))
        .await
        .unwrap();
    let (mut to_user, mut to_tools) = (user.events(), tools.events());
    user.call("session.rename", json!({ "id": a, "title": "Renamed" }))
        .await
        .unwrap();
    let got = tokio::time::timeout(std::time::Duration::from_secs(2), to_user.recv()).await;
    assert!(got.is_ok(), "the user hears the rename");
    let leaked = tokio::time::timeout(std::time::Duration::from_millis(300), to_tools.recv()).await;
    assert!(leaked.is_err(), "the tools hear nothing: {leaked:?}");
}

#[tokio::test]
async fn a_revoked_token_stops_working_on_a_connection_already_open() {
    let (m, a, _b, _plain) = sessions();
    let dir = tempfile::tempdir().unwrap();
    let server = RpcServer::start(m.clone(), dir.path(), None).await.unwrap();
    let token = m.session_token(&a);
    let tools = RpcClient::connect(server.info.port, &token).await.unwrap();
    tools.call("provider.list", json!({})).await.unwrap();
    m.set_orchestrator(&a, false).await.unwrap();
    assert!(tools.call("provider.list", json!({})).await.is_err());
    // Made an orchestrator again, the old connection still gets nothing.
    m.set_orchestrator(&a, true).await.unwrap();
    assert!(tools
        .call("orchestrator.workers", json!({ "orchestrator": a }))
        .await
        .is_err());
    let fresh = RpcClient::connect(server.info.port, &m.session_token(&a))
        .await
        .unwrap();
    fresh
        .call("orchestrator.workers", json!({ "orchestrator": a }))
        .await
        .unwrap();
}

#[tokio::test]
async fn a_team_members_token_reaches_its_own_team_and_nothing_else() {
    let store = Arc::new(MemoryStore::default());
    let add = |title: &str, owner: bool, under: Option<&str>| {
        let mut s = Session::new(&CreateSessionOpts {
            provider: ProviderKind::Claude,
            cwd: "/tmp".into(),
            title: Some(title.into()),
            orchestrator: under.is_none(),
            feature_owner: owner,
            orchestrator_id: under.map(Into::into),
            ..Default::default()
        });
        s.status = SessionStatus::Idle;
        store.upsert_session(&s).unwrap();
        s.id
    };
    let a = add("A", true, None);
    let b = add("B", true, None);
    let designer = add("Designer", false, Some(&a));
    let builder = add("Builder", false, Some(&a));
    let other = add("Other", false, Some(&b));
    let m = Manager::new(store, vec![], None);
    m.restore().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let server = RpcServer::start(m.clone(), dir.path(), None).await.unwrap();
    let user = RpcClient::connect(server.info.port, &server.info.token)
        .await
        .unwrap();
    let worker = RpcClient::connect(server.info.port, &m.session_token(&designer))
        .await
        .unwrap();

    // Its own team's tools, as itself.
    let team: String = worker
        .call_as("team.list", json!({ "worker": designer }))
        .await
        .unwrap();
    assert!(
        team.contains("Builder") && !team.contains("Other"),
        "{team}"
    );
    // Never as another worker, never the owner's tools, never the user's.
    for (method, params) in [
        ("team.list", json!({ "worker": builder })),
        (
            "team.ask",
            json!({ "worker": builder, "to": "Designer", "question": "x" }),
        ),
        (
            "owner.record_decision",
            json!({ "owner": a, "decision": "x", "rationale": "y" }),
        ),
        ("orchestrator.workers", json!({ "orchestrator": a })),
        ("feature.get", json!({ "id": a })),
    ] {
        let e = err(&worker, method, params).await;
        assert!(e.contains("not allowed"), "{method}: {e}");
    }
    // Its team is its owner's: another owner's worker is no teammate.
    let e = err(
        &worker,
        "team.ask",
        json!({ "worker": designer, "to": other, "question": "x" }),
    )
    .await;
    assert!(e.contains("is not on this team"), "{e}");
    assert!(m.feature(&a).unwrap().one_on_ones.is_empty());
    // The user's token does not act as a team member either.
    let e = err(&user, "team.list", json!({ "worker": designer })).await;
    assert!(e.contains("session token"), "{e}");
    // Its owner no longer owns a feature: it is on no team, and its token goes.
    m.set_orchestrator(&a, false).await.unwrap();
    assert!(worker.call("provider.list", json!({})).await.is_err());
}

#[tokio::test]
async fn a_call_on_a_connection_the_daemon_closed_fails_at_once() {
    let (m, a, _b, _plain) = sessions();
    let dir = tempfile::tempdir().unwrap();
    let server = RpcServer::start(m.clone(), dir.path(), None).await.unwrap();
    let tools = RpcClient::connect(server.info.port, &m.session_token(&a))
        .await
        .unwrap();
    m.set_orchestrator(&a, false).await.unwrap();
    // The revoked token closes the connection.
    assert!(tools.call("provider.list", json!({})).await.is_err());
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    // A call after that is refused now, not after the two-minute timeout.
    let late = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tools.call("provider.list", json!({})),
    )
    .await
    .expect("a call on a closed connection must not wait for its timeout");
    assert_eq!(late.unwrap_err().to_string(), "connection closed");
}
