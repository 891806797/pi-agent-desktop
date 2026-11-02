use serde::{Deserialize, Serialize};
use std::collections::HashMap;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub session_id: String,
    pub workspace: String,
    #[serde(default)]
    pub notice_version: u64,
    #[serde(default)]
    pub read_version: u64,
    pub notice_kind: Option<String>,
    #[serde(default)]
    pub pending_permissions: u32,
    #[serde(default)]
    pub pending_questions: u32,
    #[serde(default)]
    pub lifecycle: String,
}
impl Notice {
    pub fn priority(&self) -> u8 {
        if self.lifecycle == "deleted" {
            return 0;
        }
        if self.pending_permissions > 0 || self.pending_questions > 0 {
            return 2;
        }
        if self.notice_version <= self.read_version {
            return 0;
        }
        match self.notice_kind.as_deref() {
            Some("completed") => 1,
            _ => 0,
        }
    }
}
#[derive(Default)]
pub struct Attention {
    pub sessions: HashMap<String, Notice>,
    seen: HashMap<String, u64>,
    pub notification_ids: HashMap<String, i32>,
    next_id: i32,
}
impl Attention {
    pub fn notification_id(&mut self, id: &str) -> i32 {
        if let Some(value) = self.notification_ids.get(id) {
            return *value;
        }
        self.next_id = self.next_id.checked_add(1).unwrap_or(1);
        self.notification_ids.insert(id.into(), self.next_id);
        self.next_id
    }
    pub fn update(&mut self, n: Notice) -> bool {
        let p = n.priority();
        let confirmed = matches!(
            (p, n.notice_kind.as_deref()),
            (2, Some("attention")) | (1, Some("completed"))
        );
        let previous = self.seen.get(&n.session_id).copied().unwrap_or(0);
        let notify = confirmed && n.notice_version > n.read_version && n.notice_version > previous;
        self.seen
            .insert(n.session_id.clone(), previous.max(n.notice_version));
        self.sessions.insert(n.session_id.clone(), n);
        notify
    }
    pub fn snapshot(&mut self, n: Notice) -> bool {
        let pending = n.priority() == 2;
        let notify = self.update(n);
        pending && notify
    }
    pub fn target(&self) -> Option<&Notice> {
        self.sessions
            .values()
            .filter(|n| n.priority() > 0)
            .max_by_key(|n| (n.priority(), n.notice_version))
    }
    pub fn remove(&mut self, id: &str) {
        self.sessions.remove(id);
    }
    pub fn reset(&mut self) {
        self.sessions.clear();
        self.seen.clear();
        self.notification_ids.clear();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn n(id: &str, v: u64, p: u32) -> Notice {
        Notice {
            session_id: id.into(),
            workspace: "/actual".into(),
            notice_version: v,
            read_version: 0,
            notice_kind: Some(if p > 0 { "attention" } else { "completed" }.into()),
            pending_permissions: p,
            pending_questions: 0,
            lifecycle: "normal".into(),
        }
    }
    #[test]
    fn priority_replay_and_per_session_clear() {
        let mut a = Attention::default();
        assert!(a.update(n("a", 1, 0)));
        assert!(!a.update(n("a", 1, 0)));
        assert!(a.update(n("b", 1, 1)));
        assert_eq!(a.target().unwrap().session_id, "b");
        let mut b = n("b", 1, 0);
        b.read_version = 1;
        a.update(b);
        assert_eq!(a.target().unwrap().session_id, "a");
        assert!(!a.update(n("a", 1, 0)));
    }
}
#[cfg(test)]
mod transitions {
    use super::*;
    fn notice(version: u64, pending: u32, kind: &str) -> Notice {
        Notice {
            session_id: "a".into(),
            workspace: "/actual".into(),
            notice_version: version,
            read_version: 0,
            notice_kind: Some(kind.into()),
            pending_permissions: pending,
            pending_questions: 0,
            lifecycle: "normal".into(),
        }
    }
    #[test]
    fn projection_before_notice_notifies_once_and_settlement_clears() {
        let mut a = Attention::default();
        assert!(!a.update(notice(0, 1, "attention")));
        assert!(a.update(notice(1, 1, "attention")));
        assert!(!a.update(notice(1, 1, "attention")));
        a.update(notice(1, 0, "attention"));
        assert!(a.target().is_none());
    }
}

#[cfg(test)]
mod snapshots {
    use super::*;
    #[test]
    fn restores_completion_badge_without_replaying_notification() {
        let n = Notice {
            session_id: "done".into(),
            workspace: "/work".into(),
            notice_version: 10,
            read_version: 0,
            notice_kind: Some("completed".into()),
            pending_permissions: 0,
            pending_questions: 0,
            lifecycle: "normal".into(),
        };
        let mut a = Attention::default();
        assert!(!a.snapshot(n.clone()));
        assert_eq!(a.target().unwrap().priority(), 1);
        assert!(!a.snapshot(n.clone()));
        let mut newer = n;
        newer.notice_version = 11;
        assert!(a.update(newer));
    }
}
