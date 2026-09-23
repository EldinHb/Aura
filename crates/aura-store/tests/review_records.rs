use aura_core::Store;
use aura_store::SqliteStore;
#[test]
fn review_records_survive_restart_and_inbox_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("aura.db");
    {
        let store = SqliteStore::open(&path).unwrap();
        store
            .save_feature_record("reviews", "r1", "{\"status\":\"ready\"}")
            .unwrap();
        store
            .save_feature_record("hidden:github.com:alice", "o/r#1", "true")
            .unwrap();
        store.set_setting("reviews.inbox", "{}").unwrap();
    }
    let store = SqliteStore::open(&path).unwrap();
    assert_eq!(store.feature_records("reviews").unwrap().len(), 1);
    assert_eq!(
        store
            .feature_records("hidden:github.com:alice")
            .unwrap()
            .len(),
        1
    );
    assert!(store
        .feature_records("hidden:github.com:bob")
        .unwrap()
        .is_empty());
    store
        .save_feature_record("reviews", "r1", "{\"status\":\"submitted\"}")
        .unwrap();
    assert_eq!(
        store.feature_records("reviews").unwrap(),
        vec![("r1".into(), "{\"status\":\"submitted\"}".into())]
    );
}
