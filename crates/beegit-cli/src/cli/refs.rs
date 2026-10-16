//! `beegit ref list|create|set|delete|log` (amendment B-4): ref management over RefService.

use super::args::RefCmd;
use super::ctx::{Ctx, Reply};
use super::error::CliResult;
use super::util::{fmt_time, resolve, short};
use crate::output::views::{
    RefChangeData, RefListData, RefLogData, RefLogEntryView, RefView, TimeView,
};
use beegit_core::{ObjectId, Result as BeeGitResult};
use beegit_proto::convert::required_id;
use beegit_proto::{BeeGitClient, error_from_status, v1};
use std::fmt::Write as _;

/// ListRefs page size.
const LIST_PAGE: u32 = 1000;

pub(crate) async fn run(ctx: &mut Ctx<'_>, cmd: &RefCmd) -> CliResult<Reply> {
    let root = ctx.find_root();
    let client = ctx.client(root.as_deref()).await?;
    match cmd {
        RefCmd::List { prefix } => list(&client, prefix.as_deref()).await,
        RefCmd::Create { name, rev, reason } => create(&client, name, rev, reason).await,
        RefCmd::Set { name, rev, force } => set(&client, name, rev, *force).await,
        RefCmd::Delete {
            name,
            expected_version,
            reason,
        } => delete(&client, name, *expected_version, reason).await,
        RefCmd::Log { name, limit } => log(&client, name, *limit).await,
    }
}

/// `2026-10-16 09:42:26 +0000` from Unix milliseconds (same style as `log`).
fn fmt_ms(ms: i64) -> String {
    fmt_time(&TimeView {
        seconds: ms.div_euclid(1000),
        tz_offset_minutes: 0,
    })
}

fn opt_id(bytes: &[u8], field: &str) -> BeeGitResult<Option<ObjectId>> {
    if bytes.is_empty() {
        Ok(None)
    } else {
        required_id(bytes, field).map(Some)
    }
}

async fn current(client: &BeeGitClient, name: &str) -> BeeGitResult<(ObjectId, u64)> {
    let r = client
        .objects()
        .resolve_ref(v1::ResolveRefRequest {
            name: name.to_owned(),
            at_version: None,
        })
        .await
        .map_err(|s| error_from_status(&s))?
        .into_inner();
    Ok((required_id(&r.target, "target")?, r.version))
}

async fn list(client: &BeeGitClient, prefix: Option<&str>) -> CliResult<Reply> {
    let mut refs = Vec::new();
    let mut token = String::new();
    loop {
        let page = client
            .refs()
            .list_refs(v1::ListRefsRequest {
                prefix: prefix.unwrap_or_default().to_owned(),
                limit: LIST_PAGE,
                page_token: token,
            })
            .await
            .map_err(|s| error_from_status(&s))?
            .into_inner();
        for r in page.refs {
            refs.push(RefView {
                target: required_id(&r.target, "target")?.to_text(),
                name: r.name,
                version: r.version,
                updated_at_unix_ms: r.updated_at_unix_ms,
            });
        }
        if page.next_page_token.is_empty() {
            break;
        }
        token = page.next_page_token;
    }
    let width = refs.iter().map(|r| r.name.len()).max().unwrap_or(0);
    let mut human = String::new();
    for r in &refs {
        let _ = writeln!(
            human,
            "{:width$}  {}  v{:<4} {}",
            r.name,
            &r.target[..r.target.len().min(14)],
            r.version,
            fmt_ms(r.updated_at_unix_ms),
        );
    }
    let data = RefListData {
        prefix: prefix.map(str::to_owned),
        refs,
    };
    Reply::new("ref-list", data, human)
}

async fn create(client: &BeeGitClient, name: &str, rev: &str, reason: &str) -> CliResult<Reply> {
    let target = resolve(client, rev).await?;
    let r = client
        .refs()
        .create_ref(v1::CreateRefRequest {
            name: name.to_owned(),
            target: target.as_bytes().to_vec(),
            reason: reason.to_owned(),
        })
        .await
        .map_err(|s| error_from_status(&s))?
        .into_inner();
    let human = format!(
        "Created {name} at {} (version {})\n",
        short(&target),
        r.version
    );
    let data = RefChangeData {
        name: name.to_owned(),
        old_target: None,
        new_target: Some(target.to_text()),
        version: Some(r.version),
    };
    Reply::new("ref-create", data, human)
}

async fn set(client: &BeeGitClient, name: &str, rev: &str, force: bool) -> CliResult<Reply> {
    let target = resolve(client, rev).await?;
    let (old, version) = current(client, name).await?;
    let r = client
        .refs()
        .update_ref(v1::UpdateRefRequest {
            name: name.to_owned(),
            expected_version: version,
            new_target: target.as_bytes().to_vec(),
            allow_non_fast_forward: force,
        })
        .await
        .map_err(|s| error_from_status(&s))?
        .into_inner();
    let human = format!(
        "Moved {name}: {} -> {} (version {})\n",
        short(&old),
        short(&target),
        r.version
    );
    let data = RefChangeData {
        name: name.to_owned(),
        old_target: Some(old.to_text()),
        new_target: Some(target.to_text()),
        version: Some(r.version),
    };
    Reply::new("ref-set", data, human)
}

async fn delete(
    client: &BeeGitClient,
    name: &str,
    expected: Option<u64>,
    reason: &str,
) -> CliResult<Reply> {
    let (old, version) = current(client, name).await?;
    client
        .refs()
        .delete_ref(v1::DeleteRefRequest {
            name: name.to_owned(),
            expected_version: expected.unwrap_or(version),
            reason: reason.to_owned(),
        })
        .await
        .map_err(|s| error_from_status(&s))?;
    let human = format!(
        "Deleted {name} (was {} at version {})\n",
        short(&old),
        expected.unwrap_or(version)
    );
    let data = RefChangeData {
        name: name.to_owned(),
        old_target: Some(old.to_text()),
        new_target: None,
        version: None,
    };
    Reply::new("ref-delete", data, human)
}

async fn log(client: &BeeGitClient, name: &str, limit: Option<u32>) -> CliResult<Reply> {
    // The ref log pages forward from a version; fetch all, then keep the newest `limit`.
    let mut entries = Vec::new();
    let mut from = 0u64;
    loop {
        let page = client
            .refs()
            .get_ref_log(v1::GetRefLogRequest {
                name: name.to_owned(),
                from_version: from,
                limit: 0,
            })
            .await
            .map_err(|s| error_from_status(&s))?
            .into_inner();
        let Some(last) = page.entries.last().map(|e| e.version) else {
            break;
        };
        for e in page.entries {
            let landed = e
                .landed
                .iter()
                .filter_map(|l| opt_id(&l.result, "result").transpose())
                .map(|r| r.map(|id| id.to_text()))
                .collect::<BeeGitResult<Vec<_>>>()?;
            entries.push(RefLogEntryView {
                version: e.version,
                old_target: opt_id(&e.old_target, "old_target")?.map(|i| i.to_text()),
                new_target: opt_id(&e.new_target, "new_target")?.map(|i| i.to_text()),
                principal: e.principal,
                at_unix_ms: e.at_unix_ms,
                landed,
            });
        }
        if last < from {
            break; // no progress: stop rather than loop
        }
        from = last + 1;
    }
    if let Some(l) = limit {
        let skip = entries.len().saturating_sub(l as usize);
        entries.drain(..skip);
    }
    let shorten = |t: &Option<String>| match t {
        Some(t) => t.chars().take(14).collect::<String>(),
        None => "-".to_owned(),
    };
    let mut human = String::new();
    for e in &entries {
        let _ = write!(
            human,
            "v{:<4} {}  {} -> {}  {}",
            e.version,
            fmt_ms(e.at_unix_ms),
            shorten(&e.old_target),
            shorten(&e.new_target),
            e.principal,
        );
        if !e.landed.is_empty() {
            let _ = write!(human, "  (landed {})", e.landed.len());
        }
        human.push('\n');
    }
    let data = RefLogData {
        name: name.to_owned(),
        entries,
    };
    Reply::new("ref-log", data, human)
}
