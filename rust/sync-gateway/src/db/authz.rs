//! Server-side document authorization (P3-M015).
//!
//! ONE canonical policy layer. The SQL resolves the Phase 1 data
//! (documents + ACL grants + org memberships) into the effective role
//! exactly as `src/server/auth/authorization.ts` computes it
//! (owner > direct ACL grant > org-member EDITOR > deny); Rust maps rows
//! to [`EffectiveRole`] and derives capabilities. A nonexistent document
//! and a no-access document are indistinguishable to the caller (both
//! `None`) — no existence leak.

use crate::protocol::control::Role as WireRole;

/// Effective role for a (user, document) pair. `None` = deny / not found
/// (deliberately indistinguishable).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectiveRole {
    Owner,
    Editor,
    Commenter,
    Viewer,
}

/// Capability set derived from the effective role (mirrors
/// docs/AUTHORIZATION.md; COMMENTER/VIEWER never write content).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocumentAccess {
    pub role: EffectiveRole,
}

impl EffectiveRole {
    /// Maps the SQL row (owner?, direct role?, org member?) to the
    /// effective role. `is_owner` short-circuits; direct ACL wins over
    /// org membership; org membership grants EDITOR (Phase 1 semantics).
    /// The SQL enum renders as UPPERCASE text (`EDITOR`); matching is
    /// case-insensitive so enum-label changes cannot silently deny.
    pub fn resolve(is_owner: bool, direct_role: Option<&str>, org_member: bool) -> Option<Self> {
        if is_owner {
            return Some(EffectiveRole::Owner);
        }
        let direct = direct_role.and_then(|r| match r.to_ascii_lowercase().as_str() {
            "editor" => Some(EffectiveRole::Editor),
            "commenter" => Some(EffectiveRole::Commenter),
            "viewer" => Some(EffectiveRole::Viewer),
            _ => None,
        });
        // Unknown/null direct grant falls through to org membership.
        direct.or(if org_member {
            Some(EffectiveRole::Editor)
        } else {
            None
        })
    }

    pub fn can_view(self) -> bool {
        true // all four roles may read
    }

    /// OWNER/EDITOR write document content; COMMENTER/VIEWER may not
    /// (P3-M037 policy — Phase 3 rechecks on every write batch).
    pub fn can_edit(self) -> bool {
        matches!(self, EffectiveRole::Owner | EffectiveRole::Editor)
    }

    pub fn can_comment(self) -> bool {
        !matches!(self, EffectiveRole::Viewer) && true // OWNER/EDITOR/COMMENTER
    }

    pub fn is_owner(self) -> bool {
        matches!(self, EffectiveRole::Owner)
    }

    /// Wire protocol role (PROTOCOL §9.4, lowercased).
    pub fn to_wire(self) -> WireRole {
        match self {
            EffectiveRole::Owner => WireRole::Owner,
            EffectiveRole::Editor => WireRole::Editor,
            EffectiveRole::Commenter => WireRole::Commenter,
            EffectiveRole::Viewer => WireRole::Viewer,
        }
    }
}

impl DocumentAccess {
    pub fn view(&self) -> bool {
        self.role.can_view()
    }
    pub fn edit(&self) -> bool {
        self.role.can_edit()
    }
    pub fn comment(&self) -> bool {
        self.role.can_comment()
    }
    pub fn owner(&self) -> bool {
        self.role.is_owner()
    }
}

/// The one authorization query (static, parameterized — never concatenated).
/// Returns (is_owner, direct_role, org_member) or None when the user has no
/// relationship with a document (or the document does not exist).
pub(crate) const AUTHZ_QUERY: &str = r#"
    SELECT
        (d.owner_user_id = $1::uuid)          AS is_owner,
        p.role::text                          AS direct_role,
        (m.organization_id IS NOT NULL)       AS org_member
    FROM documents d
    LEFT JOIN document_user_permissions p
        ON p.document_id = d.id AND p.user_id = $1::uuid
    LEFT JOIN organization_memberships m
        ON m.organization_id = d.organization_id AND m.user_id = $1::uuid
    WHERE d.id = $2::uuid
"#;

#[cfg(test)]
mod tests {
    use super::*;

    /// Table-driven: every (owner, direct, org) combination resolves to the
    /// documented effective role, and none of them leaks existence.
    #[test]
    fn effective_role_table() {
        use EffectiveRole as R;
        let cases: &[(bool, Option<&str>, bool, Option<R>)] = &[
            // Owner wins over everything.
            (true, Some("editor"), true, Some(R::Owner)),
            (true, None, false, Some(R::Owner)),
            (true, Some("viewer"), false, Some(R::Owner)),
            // Direct ACL beats org membership.
            (false, Some("editor"), true, Some(R::Editor)),
            (false, Some("commenter"), true, Some(R::Commenter)),
            (false, Some("viewer"), true, Some(R::Viewer)),
            (false, Some("editor"), false, Some(R::Editor)),
            (false, Some("commenter"), false, Some(R::Commenter)),
            (false, Some("viewer"), false, Some(R::Viewer)),
            // Org member with no direct grant → EDITOR (Phase 1).
            (false, None, true, Some(R::Editor)),
            // Unknown direct role string falls through to org check.
            (false, Some("bogus"), true, Some(R::Editor)),
            // SQL enum renders UPPERCASE labels — must resolve identically.
            (false, Some("EDITOR"), false, Some(R::Editor)),
            (false, Some("COMMENTER"), false, Some(R::Commenter)),
            (false, Some("VIEWER"), false, Some(R::Viewer)),
            // Deny-by-default.
            (false, None, false, None),
        ];
        for (owner, direct, org, expected) in cases {
            assert_eq!(
                EffectiveRole::resolve(*owner, *direct, *org),
                *expected,
                "case owner={owner} direct={direct:?} org={org}"
            );
        }
    }

    #[test]
    fn capability_matrix_matches_prd() {
        // read: all roles; editContent: OWNER/EDITOR only.
        for role in [
            EffectiveRole::Owner,
            EffectiveRole::Editor,
            EffectiveRole::Commenter,
            EffectiveRole::Viewer,
        ] {
            assert!(role.can_view(), "{role:?} must view");
            assert_eq!(
                role.can_edit(),
                matches!(role, EffectiveRole::Owner | EffectiveRole::Editor)
            );
            assert_eq!(role.is_owner(), matches!(role, EffectiveRole::Owner));
        }
        assert!(EffectiveRole::Commenter.can_comment());
        assert!(!EffectiveRole::Viewer.can_comment());
    }

    #[test]
    fn wire_role_mapping() {
        assert_eq!(
            EffectiveRole::Owner.to_wire(),
            crate::protocol::control::Role::Owner
        );
        assert_eq!(
            EffectiveRole::Viewer.to_wire(),
            crate::protocol::control::Role::Viewer
        );
    }
}
