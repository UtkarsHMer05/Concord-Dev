//! Conservative three-way review planning. Whole nested lists form one review
//! unit, so selecting a child cannot detach it from its parent.
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Debug)]
struct Hunk {
    start: usize,
    end: usize,
    changed_start: usize,
    changed_end: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeChange {
    pub id: String,
    pub base: Vec<Value>,
    pub current: Vec<Value>,
    pub proposed: Vec<Value>,
    pub conflict: bool,
    pub already_applied: bool,
    pub range: [u32; 4],
}

fn units(blocks: &[Value]) -> Vec<Vec<Value>> {
    let mut result: Vec<Vec<Value>> = Vec::new();
    let mut in_list = false;
    for block in blocks {
        let list = matches!(
            block["type"].as_str(),
            Some("list-item" | "list-continuation")
        );
        if list && in_list {
            result.last_mut().unwrap().push(block.clone());
        } else {
            result.push(vec![block.clone()]);
        }
        in_list = list;
    }
    result
}

// Patience diff: unique unchanged units anchor the review; ambiguous duplicates
// intentionally form a larger change rather than attach to the wrong paragraph.
fn diff(base: &[Vec<Value>], changed: &[Vec<Value>]) -> Vec<Hunk> {
    if base == changed {
        return vec![];
    }
    let keys = |values: &[Vec<Value>]| {
        values
            .iter()
            .map(|v| {
                // JSONB reorders object keys; native JSON and saved bases must
                // share a signature regardless of serialization order.
                let mut key = Value::Array(v.clone());
                key.sort_all_objects();
                serde_json::to_string(&key).unwrap()
            })
            .collect::<Vec<_>>()
    };
    let a = keys(base);
    let b = keys(changed);
    let counts = |values: &[String]| {
        let mut out = HashMap::new();
        for value in values {
            *out.entry(value.clone()).or_insert(0) += 1;
        }
        out
    };
    let ac = counts(&a);
    let bc = counts(&b);
    let indexes: HashMap<&String, usize> = b
        .iter()
        .enumerate()
        .filter(|(_, k)| bc[*k] == 1)
        .map(|(i, k)| (k, i))
        .collect();
    let candidates: Vec<(usize, usize)> = a
        .iter()
        .enumerate()
        .filter_map(|(i, k)| {
            if ac[k] == 1 {
                indexes.get(k).map(|j| (i, *j))
            } else {
                None
            }
        })
        .collect();
    let mut tails: Vec<usize> = vec![];
    let mut last: Vec<usize> = vec![];
    let mut previous = vec![None; candidates.len()];
    for (i, &(_, j)) in candidates.iter().enumerate() {
        let p = tails.partition_point(|v| *v < j);
        if p > 0 {
            previous[i] = Some(last[p - 1]);
        }
        if p == tails.len() {
            tails.push(j);
            last.push(i);
        } else {
            tails[p] = j;
            last[p] = i;
        }
    }
    let mut anchors = vec![];
    let mut cursor = last.last().copied();
    while let Some(i) = cursor {
        anchors.push(candidates[i]);
        cursor = previous[i];
    }
    anchors.reverse();
    anchors.push((base.len(), changed.len()));
    let (mut x, mut y) = (0, 0);
    let mut result = vec![];
    for (i, j) in anchors {
        if x < i || y < j {
            result.push(Hunk {
                start: x,
                end: i,
                changed_start: y,
                changed_end: j,
            });
        }
        x = i + 1;
        y = j + 1;
    }
    result
}

fn overlaps(a: &Hunk, b: &Hunk) -> bool {
    if a.start == a.end {
        a.start >= b.start && a.start <= b.end
    } else if b.start == b.end {
        b.start >= a.start && b.start <= a.end
    } else {
        a.start < b.end && b.start < a.end
    }
}

fn mapped(zone: &Hunk, hunks: &[Hunk]) -> (usize, usize) {
    let shift: isize = hunks
        .iter()
        .filter(|h| h.end <= zone.start && !overlaps(zone, h))
        .map(|h| (h.changed_end - h.changed_start) as isize - (h.end - h.start) as isize)
        .sum();
    let inside: isize = hunks
        .iter()
        .filter(|h| overlaps(zone, h))
        .map(|h| (h.changed_end - h.changed_start) as isize - (h.end - h.start) as isize)
        .sum();
    (
        (zone.start as isize + shift) as usize,
        (zone.end as isize + shift + inside) as usize,
    )
}

pub fn plan(base: &[Value], current: &[Value], branch: &[Value]) -> Vec<MergeChange> {
    let a = units(base);
    let b = units(current);
    let c = units(branch);
    let main_hunks = diff(&a, &b);
    let branch_hunks = diff(&a, &c);
    let flatten = |values: &[Vec<Value>], from: usize, to: usize| {
        values[from..to]
            .iter()
            .flatten()
            .cloned()
            .collect::<Vec<_>>()
    };
    let offset = |values: &[Vec<Value>], index: usize| {
        values[..index].iter().map(Vec::len).sum::<usize>() as u32
    };
    let mut zones: Vec<Hunk> = vec![];
    for hunk in &branch_hunks {
        let mut zone = hunk.clone();
        loop {
            let old = (zone.start, zone.end);
            // ponytail: conservative connected hunks, bounded at 2,000 units;
            // an interval sweep is the upgrade if large reviews need it.
            for h in main_hunks.iter().chain(branch_hunks.iter()) {
                if overlaps(&zone, h) {
                    zone.start = zone.start.min(h.start);
                    zone.end = zone.end.max(h.end);
                }
            }
            if old == (zone.start, zone.end) {
                break;
            }
        }
        if !zones
            .iter()
            .any(|z| z.start == zone.start && z.end == zone.end)
        {
            zones.push(zone);
        }
    }
    zones.sort_by_key(|h| h.start);
    zones
        .into_iter()
        .enumerate()
        .map(|(i, zone)| {
            let (bs, be) = mapped(&zone, &main_hunks);
            let (cs, ce) = mapped(&zone, &branch_hunks);
            let current = flatten(&b, bs, be);
            let proposed = flatten(&c, cs, ce);
            let already_applied = current == proposed;
            MergeChange {
                id: format!("change-{i}"),
                base: flatten(&a, zone.start, zone.end),
                current,
                proposed,
                conflict: !already_applied && main_hunks.iter().any(|h| overlaps(&zone, h)),
                already_applied,
                range: [
                    offset(&b, bs),
                    offset(&b, be),
                    offset(&c, cs),
                    offset(&c, ce),
                ],
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn p(text: &str) -> Value {
        json!({"type":"paragraph", "attrs":{}, "runs":[{"t":text,"m":{}}]})
    }
    #[test]
    fn preserves_independent_main_edits_and_selects_only_branch_changes() {
        let base = vec![
            p("Intro"),
            p("anchor"),
            p("Implementation"),
            p("end"),
            p("Budget"),
        ];
        let mut current = base.clone();
        current[4] = p("Bob's budget");
        let mut branch = base.clone();
        branch[0] = p("Alice's intro");
        branch[2] = p("Alice's plan");
        let changes = plan(&base, &current, &branch);
        assert_eq!(changes.len(), 2);
        assert!(changes.iter().all(|c| !c.conflict));
        assert_eq!(changes[0].range, [0, 1, 0, 1]);
        assert_eq!(changes[1].range, [2, 3, 2, 3]);
    }
    #[test]
    fn groups_overlapping_changes_for_explicit_resolution() {
        let base = vec![p("a"), p("b"), p("c")];
        let current = vec![p("Bob's whole proposal")];
        let branch = vec![p("Alice"), p("b"), p("Carol")];
        let c = plan(&base, &current, &branch);
        assert_eq!(c.len(), 1);
        assert!(c[0].conflict);
        assert_eq!(c[0].range, [0, 1, 0, 3]);
    }
    #[test]
    fn repeated_insertions_deletions_and_already_present_are_safe() {
        let base = vec![p("same"), p("same"), p("tail")];
        let branch = vec![p("new"), p("same"), p("tail")];
        assert!(plan(&base, &branch, &branch)[0].already_applied);
        let c = plan(
            &[p("a"), p("b")],
            &[p("a"), p("b")],
            &[p("a"), p("x"), p("b")],
        );
        assert_eq!(c[0].range, [1, 1, 1, 2]);
        let c = plan(&[p("a"), p("b")], &[p("a"), p("b")], &[p("b")]);
        assert_eq!(c[0].range, [0, 1, 0, 0]);
    }
    #[test]
    fn nested_lists_are_one_atomic_review_unit() {
        let mut list = vec![
            json!({"type":"list-item","attrs":{"depth":"0"}}),
            json!({"type":"list-item","attrs":{"depth":"1"}}),
            p("end"),
        ];
        let base = list.clone();
        list[1]["attrs"]["checked"] = json!("yes");
        let c = plan(&base, &base, &list);
        assert_eq!(c[0].range, [0, 2, 0, 2]);
    }
    #[test]
    fn jsonb_key_order_does_not_turn_unrelated_edits_into_a_conflict() {
        let base = vec![p("intro"), p("budget")];
        let mut saved = Value::Array(base.clone());
        saved.sort_all_objects();
        let current = vec![p("intro"), p("Bob's budget")];
        let branch = vec![p("Alice's intro"), p("budget")];
        let changes = plan(saved.as_array().unwrap(), &current, &branch);
        assert_eq!(changes.len(), 1);
        assert!(!changes[0].conflict);
        assert_eq!(changes[0].range, [0, 1, 0, 1]);
    }
}
