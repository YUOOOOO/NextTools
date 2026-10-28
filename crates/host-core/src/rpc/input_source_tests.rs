use super::*;

#[tokio::test]
async fn input_source_rpc_roundtrip_reopens_full_and_bounded_history() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let session = sessions::create_session(&app.db, None, None, None, None, None).unwrap();
    let state = Arc::new(Mutex::new(app));
    let body = "web input ".repeat(10_000);
    for (id, role, content, source) in [
        ("local", "user", "local input", None),
        ("web", "user", body.as_str(), Some("web")),
        ("answer", "assistant", "answer", None),
    ] {
        let mut message = json!({"id":id,"role":role,"content":content,
            "createdAt":"2026-10-01T00:00:00Z"});
        if let Some(source) = source {
            message["inputSource"] = json!(source);
        }
        handle_request(
            state.clone(),
            "session.appendMessage",
            json!({"sessionId":session.id,"message":message}),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
    }
    // Close all Host state and database handles before constructing a new Host.
    drop(state);
    let mut reopened = AppState::open(dir.path()).unwrap();
    reopened.handshook = true;
    let records = transcripts::read_transcript(reopened.db.data_dir(), &session.id).unwrap();
    assert!(records[0]
        .meta
        .as_ref()
        .and_then(|m| m.get("inputSource"))
        .is_none());
    assert_eq!(records[1].meta.as_ref().unwrap()["inputSource"], "web");
    let state = Arc::new(Mutex::new(reopened));
    let full = handle_request(
        state.clone(),
        "session.get",
        json!({"id":session.id}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let messages = full["session"]["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 3);
    assert!(messages[0].get("inputSource").is_none());
    assert_eq!(messages[1]["inputSource"], "web");
    assert_eq!(messages[1]["content"], body);
    assert!(messages[2].get("inputSource").is_none());
    let bounded = handle_request(
        state.clone(),
        "session.get",
        json!({"id":session.id,"messageBefore":2,"messageLimit":1,"contentLimit":128}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    let page = &bounded["session"];
    assert_eq!(page["messageStart"], 1);
    assert_eq!(page["hasMoreBefore"], true);
    assert_eq!(page["messages"].as_array().unwrap().len(), 1);
    assert_eq!(page["messages"][0]["inputSource"], "web");
    assert!(page["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("truncated for display"));
    for source in [json!("desktop"), json!(7), json!({})] {
        let error = handle_request(
            state.clone(),
            "session.appendMessage",
            json!({"sessionId":session.id,"message":{"id":"invalid","role":"user",
                "content":"bad","createdAt":"2026-10-01T00:00:00Z","inputSource":source}}),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, 1002);
    }
}
