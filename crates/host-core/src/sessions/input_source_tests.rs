use super::*;

fn message(role: &str, source: Option<Value>) -> Value {
    let mut row = json!({"id":"web-row", "role":role, "content":"hello",
        "createdAt":"2026-10-01T00:00:00Z"});
    if let Some(source) = source {
        row["inputSource"] = source;
    }
    row
}

#[test]
fn input_source_accepts_only_web_and_omits_local_metadata() {
    let local: UiMessage = serde_json::from_value(message("user", None)).unwrap();
    assert!(local.input_source.is_none());
    assert!(json!(local).get("inputSource").is_none());
    let web: UiMessage = serde_json::from_value(message("user", Some(json!("web")))).unwrap();
    assert_eq!(web.input_source, Some(InputSource::Web));
    assert_eq!(json!(web)["inputSource"], "web");
    for invalid in [
        json!("local"),
        json!("WEB"),
        json!(""),
        json!(42),
        json!({}),
        json!([]),
    ] {
        assert!(serde_json::from_value::<UiMessage>(message("user", Some(invalid))).is_err());
    }
}

#[test]
fn input_source_never_projects_web_on_non_user_or_invalid_legacy_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    for role in ["assistant", "tool", "system"] {
        let row: UiMessage = serde_json::from_value(message(role, Some(json!("web")))).unwrap();
        assert!(append_message(&db, &session.id, &row, None).is_err());
        let (mut record, _) = ui_to_record(&row);
        assert!(record
            .meta
            .as_ref()
            .and_then(|v| v.get("inputSource"))
            .is_none());
        // Imported or previously written metadata cannot label non-user rows.
        record.meta = Some(json!({"inputSource":"web"}));
        assert!(record_to_ui(record).input_source.is_none());
    }
    let row: UiMessage = serde_json::from_value(message("user", None)).unwrap();
    let (mut record, _) = ui_to_record(&row);
    record.meta = Some(json!({"inputSource":"invalid"}));
    assert!(record_to_ui(record).input_source.is_none());
    assert!(get_session(&db, &session.id)
        .unwrap()
        .unwrap()
        .messages
        .is_empty());
}

#[test]
fn input_source_survives_revision_activation_fork_and_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    let web: UiMessage = serde_json::from_value(message("user", Some(json!("web")))).unwrap();
    append_message(&db, &session.id, &web, None).unwrap();
    save_message_revision(&db, &session.id, &web.id, std::slice::from_ref(&web), true).unwrap();
    let restored = activate_message_revision(&db, &session.id, &web.id, 1, &[]).unwrap();
    assert_eq!(restored[0].input_source, Some(InputSource::Web));
    let child = match fork_session_through(&db, &session.id, None, None).unwrap() {
        ForkSessionResult::Created(child) => child,
        _ => panic!("expected fork"),
    };
    assert_eq!(child.messages[0].input_source, Some(InputSource::Web));
    assert_ne!(child.messages[0].id, web.id);
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    for id in [&session.id, &child.summary.id] {
        let detail = get_session(&db, id).unwrap().unwrap();
        assert_eq!(detail.messages[0].input_source, Some(InputSource::Web));
        let records = transcripts::read_transcript(db.data_dir(), id).unwrap();
        assert_eq!(records[0].meta.as_ref().unwrap()["inputSource"], "web");
    }
}
