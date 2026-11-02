//! 內建任務引擎。資料存在專案資料目錄的 tasks.json（每個功能一個群組）。
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::core::home::with_lock;
use crate::core::util::{js_string, now_iso, read_json, resolve, today, valid_skill_name, write_json};
use crate::core::{AppError, Result};

pub const TASK_STATUSES: [&str; 7] = ["pending", "in-progress", "review", "done", "blocked", "cancelled", "deferred"];
const OPEN: [&str; 3] = ["pending", "in-progress", "review"];

pub fn tasks_file(root: &Path) -> PathBuf {
    crate::core::state::data_dir(root).join("tasks.json")
}

fn legacy_file(root: &Path) -> PathBuf {
    root.join(".taskmaster").join("tasks").join("tasks.json")
}

fn empty() -> Value {
    json!({ "version": 1, "currentTag": "master", "groups": {}, "events": [] })
}

fn parse(file: &Path) -> Result<Value> {
    serde_json::from_str(&fs::read_to_string(file)?).map_err(|e| AppError::new(format!("{} 格式錯誤：{e}", file.display())))
}

fn load_store(root: &Path) -> Result<Value> {
    let file = tasks_file(root);
    if file.exists() {
        let store = parse(&file)?;
        if store["version"] != 1 || !store["groups"].is_object() || !store["currentTag"].as_str().is_some_and(|t| !t.is_empty()) {
            crate::bail!("任務資料格式不支援");
        }
        return Ok(store);
    }
    let mut store = empty();
    if !legacy_file(root).exists() {
        return Ok(store);
    }
    // 首次使用時匯入舊 Task Master 資料（不改動來源）。
    let old = parse(&legacy_file(root))?;
    store["groups"] = if old["tasks"].is_array() { json!({ "master": old }) } else { old };
    let state_file = root.join(".taskmaster").join("state.json");
    if state_file.exists() {
        if let Some(tag) = parse(&state_file)?["currentTag"].as_str().filter(|t| !t.is_empty()) {
            store["currentTag"] = json!(tag);
        }
    }
    store["events"].as_array_mut().unwrap().push(json!({ "at": now_iso(), "kind": "import-task-master" }));
    Ok(store)
}

fn mutate<T>(root: &Path, change: impl FnOnce(&mut Value) -> Result<T>) -> Result<T> {
    let key = hex::encode(Sha256::digest(resolve(root).to_string_lossy().to_lowercase().as_bytes()));
    with_lock(&format!("tasks-{key}"), || {
        let mut store = load_store(root)?;
        let out = change(&mut store)?;
        write_json(&tasks_file(root), &store)?;
        Ok(out)
    })
}

fn push_event(store: &mut Value, event: Value) {
    if !store["events"].is_array() {
        store["events"] = json!([]);
    }
    store["events"].as_array_mut().unwrap().push(event);
}

pub fn current_tag(root: &Path) -> Result<String> {
    Ok(load_store(root)?["currentTag"].as_str().unwrap_or("master").to_string())
}

fn group_tasks(store: &Value) -> Vec<Value> {
    let tag = store["currentTag"].as_str().unwrap_or("");
    store["groups"].get(tag).and_then(|g| g["tasks"].as_array()).cloned().unwrap_or_default()
}

pub fn read_tasks(root: &Path) -> Result<Vec<Value>> {
    Ok(group_tasks(&load_store(root)?))
}

pub fn tag_name(date: &str, slug: &str, existing: &[String]) -> String {
    let raw = format!("f-{}-{slug}", date.replace('-', ""));
    let mut base = String::new();
    let mut in_bad = false;
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            base.push(c);
            in_bad = false;
        } else if !in_bad {
            base.push('-');
            in_bad = true;
        }
    }
    let base = base.trim_end_matches('-').to_string();
    let mut name = base.clone();
    let mut i = 2;
    while existing.contains(&name) {
        name = format!("{base}-{i}");
        i += 1;
    }
    name
}

/// 目前群組已有任務時改用新的功能群組，開始新功能不會覆蓋上一個功能的任務。
pub fn use_feature_tag(root: &Path, slug: &str) -> Result<String> {
    mutate(root, |store| {
        if !group_tasks(store).is_empty() {
            let existing: Vec<String> = store["groups"].as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
            store["currentTag"] = json!(tag_name(&today(), slug, &existing));
        }
        Ok(store["currentTag"].as_str().unwrap_or("master").to_string())
    })
}

/// 扁平化後的任務（子任務 id 為 "父.子"）。parent 是頂層任務的索引。
struct Flat {
    id: String,
    deps: Vec<String>,
    status: String,
    parent: Option<usize>,
    index: usize,
    sub_index: Option<usize>,
    has_subtasks: bool,
}

fn deps_of(task: &Value) -> Vec<String> {
    task["dependencies"].as_array().map(|a| a.iter().map(js_string).collect()).unwrap_or_default()
}

fn flatten(tasks: &[Value]) -> Vec<Flat> {
    let mut out = Vec::new();
    for (i, task) in tasks.iter().enumerate() {
        let id = js_string(&task["id"]);
        let subs = task["subtasks"].as_array().cloned().unwrap_or_default();
        out.push(Flat {
            id: id.clone(),
            deps: deps_of(task),
            status: task["status"].as_str().unwrap_or("pending").into(),
            parent: None,
            index: i,
            sub_index: None,
            has_subtasks: !subs.is_empty(),
        });
        for (k, sub) in subs.iter().enumerate() {
            let deps = deps_of(sub).into_iter().map(|d| if d.contains('.') { d } else { format!("{id}.{d}") }).collect();
            out.push(Flat {
                id: format!("{id}.{}", js_string(&sub["id"])),
                deps,
                status: sub["status"].as_str().unwrap_or("pending").into(),
                parent: Some(i),
                index: i,
                sub_index: Some(k),
                has_subtasks: false,
            });
        }
    }
    out
}

fn clean_task(task: &Value, index: usize, sub: bool, preserve_status: bool, ids: &mut HashSet<String>) -> Result<Value> {
    let title = task.get("title").and_then(Value::as_str).map(str::trim).unwrap_or("");
    if title.is_empty() {
        crate::bail!("任務缺少 title");
    }
    // Number.isSafeInteger(id) && id >= 1；1.0 這類整數值的浮點數也接受。
    let id_num = match task.get("id") {
        None | Some(Value::Null) => Some(index as f64 + 1.0),
        Some(v) => v.as_f64().filter(|_| v.is_number()),
    };
    let Some(n) = id_num.filter(|n| n.fract() == 0.0 && *n >= 1.0 && *n <= 9_007_199_254_740_991.0) else {
        crate::bail!("任務 id 必須是正整數");
    };
    let id = json!(n as i64);
    let id_str = js_string(&id);
    if !sub && !ids.insert(id_str.clone()) {
        crate::bail!("重複任務 id：{id_str}");
    }
    if task.get("dependencies").is_some_and(|d| !d.is_array()) {
        crate::bail!("任務 {id_str} 的 dependencies 必須是陣列");
    }
    if let Some(skills) = task.get("skills") {
        if !skills.as_array().is_some_and(|a| a.iter().all(|s| s.as_str().is_some_and(valid_skill_name))) {
            crate::bail!("任務 {id_str} 的 skills 格式錯誤");
        }
    }
    let status = if preserve_status { task.get("status").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("pending") } else { "pending" };
    if !TASK_STATUSES.contains(&status) {
        crate::bail!("任務 {id_str} 狀態不正確");
    }
    let mut deps: Vec<String> = Vec::new();
    for d in deps_of(task) {
        if !deps.contains(&d) {
            deps.push(d);
        }
    }
    let priority = task.get("priority").and_then(Value::as_str).filter(|p| ["high", "medium", "low"].contains(p)).unwrap_or("medium");
    let text = |k: &str| match task.get(k) {
        None | Some(Value::Null) => String::new(),
        Some(v) => if crate::core::util::truthy(Some(v)) { js_string(v) } else { String::new() },
    };
    let subtasks = if sub {
        vec![]
    } else {
        let mut sub_ids = HashSet::new();
        task.get("subtasks").and_then(Value::as_array).cloned().unwrap_or_default().iter().enumerate()
            .map(|(i, t)| clean_task(t, i, true, preserve_status, &mut sub_ids))
            .collect::<Result<Vec<_>>>()?
    };
    let mut out: Map<String, Value> = task.as_object().cloned().unwrap_or_default();
    out.insert("id".into(), id);
    out.insert("title".into(), json!(title));
    out.insert("description".into(), json!(text("description")));
    out.insert("details".into(), json!(text("details")));
    out.insert("testStrategy".into(), json!(text("testStrategy")));
    out.insert("priority".into(), json!(priority));
    out.insert("dependencies".into(), json!(deps));
    out.insert("status".into(), json!(status));
    out.insert("skills".into(), task.get("skills").cloned().unwrap_or(json!([])));
    out.insert("subtasks".into(), Value::Array(subtasks));
    Ok(Value::Object(out))
}

fn normalize(tasks: &[Value], preserve_status: bool) -> Result<Vec<Value>> {
    if tasks.is_empty() {
        crate::bail!("任務清單是空的");
    }
    let mut ids = HashSet::new();
    let normalized = tasks.iter().enumerate().map(|(i, t)| clean_task(t, i, false, preserve_status, &mut ids)).collect::<Result<Vec<_>>>()?;
    let all = flatten(&normalized);
    let mut graph: HashMap<String, Vec<String>> = HashMap::new();
    let mut order = Vec::new();
    for t in &all {
        if graph.insert(t.id.clone(), t.deps.clone()).is_some() {
            crate::bail!("重複任務 id：{}", t.id);
        }
        order.push(t.id.clone());
    }
    // 父任務要等所有子任務完成；子任務也繼承父任務的依賴。一起納入循環檢查。
    for task in &normalized {
        let id = js_string(&task["id"]);
        let parent_deps = deps_of(task);
        for sub in task["subtasks"].as_array().unwrap() {
            let sub_id = format!("{id}.{}", js_string(&sub["id"]));
            graph.get_mut(&id).unwrap().push(sub_id.clone());
            graph.get_mut(&sub_id).unwrap().extend(parent_deps.iter().cloned());
        }
    }
    let mut visited = HashSet::new();
    let mut visiting = HashSet::new();
    fn visit(id: &str, graph: &HashMap<String, Vec<String>>, visited: &mut HashSet<String>, visiting: &mut HashSet<String>) -> Result<()> {
        let Some(deps) = graph.get(id) else { crate::bail!("不存在的任務依賴：{id}") };
        if visiting.contains(id) {
            crate::bail!("任務有循環依賴：{id}");
        }
        if visited.contains(id) {
            return Ok(());
        }
        visiting.insert(id.to_string());
        for dep in deps {
            visit(dep, graph, visited, visiting)?;
        }
        visiting.remove(id);
        visited.insert(id.to_string());
        Ok(())
    }
    for id in &order {
        visit(id, &graph, &mut visited, &mut visiting)?;
    }
    Ok(normalized)
}

pub fn validate_tasks(tasks: &[Value]) -> Result<Vec<Value>> {
    normalize(tasks, false)
}

fn valid_tag(tag: &str) -> bool {
    !tag.is_empty() && tag.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') && !["__proto__", "constructor", "prototype"].contains(&tag)
}

/// tag 為 None 時寫入目前群組。
pub fn write_tasks(root: &Path, tasks: &[Value], tag: Option<&str>, metadata: Value) -> Result<Vec<Value>> {
    let tag = match tag {
        Some(t) => t.to_string(),
        None => current_tag(root)?,
    };
    let clean = normalize(tasks, false)?;
    mutate(root, |store| {
        if !valid_tag(&tag) {
            crate::bail!("任務群組名稱格式錯誤");
        }
        let mut meta = metadata.as_object().cloned().unwrap_or_default();
        meta.insert("updated".into(), json!(now_iso()));
        crate::core::util::obj(&mut store["groups"]).insert(tag.clone(), json!({ "tasks": clean, "metadata": meta }));
        store["currentTag"] = json!(tag);
        push_event(store, json!({ "kind": "generate", "tag": tag, "at": now_iso(), "count": clean.len() }));
        Ok(clean.clone())
    })
}

/// 找任務（子任務 id 為 "父.子"）；回傳的子任務帶 parent 欄位與展開後的 dependencies。
pub fn find_task(root: &Path, id: &str) -> Result<Option<Value>> {
    let tasks = read_tasks(root)?;
    for t in flatten(&tasks) {
        if t.id != id {
            continue;
        }
        return Ok(Some(match t.sub_index {
            None => tasks[t.index].clone(),
            Some(k) => {
                let parent = &tasks[t.index];
                let mut sub = parent["subtasks"][k].as_object().cloned().unwrap_or_default();
                sub.insert("id".into(), json!(t.id));
                sub.insert("parent".into(), parent.clone());
                sub.insert("dependencies".into(), json!(t.deps));
                Value::Object(sub)
            }
        }));
    }
    Ok(None)
}

fn eligible(task: &Flat, all: &[Flat]) -> bool {
    let done: HashSet<&str> = all.iter().filter(|t| t.status == "done" || t.status == "completed").map(|t| t.id.as_str()).collect();
    task.deps.iter().all(|d| done.contains(d.as_str())) && task.parent.is_none_or(|p| all.iter().find(|t| t.sub_index.is_none() && t.index == p).unwrap().deps.iter().all(|d| done.contains(d.as_str())))
}

/// JS `localeCompare(b, undefined, { numeric: true })` 的簡化版：連續數字以數值比較。
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = a.peek().copied().filter(char::is_ascii_digit) {
                    na.push(c);
                    a.next();
                }
                let mut nb = String::new();
                while let Some(c) = b.peek().copied().filter(char::is_ascii_digit) {
                    nb.push(c);
                    b.next();
                }
                let ord = na.trim_start_matches('0').len().cmp(&nb.trim_start_matches('0').len()).then_with(|| na.trim_start_matches('0').cmp(nb.trim_start_matches('0')));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                let ord = x.cmp(&y);
                if ord != Ordering::Equal {
                    return ord;
                }
                a.next();
                b.next();
            }
        }
    }
}

pub fn next_task_id(root: &Path) -> Result<Option<String>> {
    let current = read_tasks(root)?;
    if current.is_empty() {
        return Ok(None);
    }
    let tasks = normalize(&current, true)?;
    let all = flatten(&tasks);
    // 「前線」：依賴都完成的任務。照拆任務時排好的清單順序做（清單就是實作順序），進行中或審查中的先接著做完；
    // 優先序只用來顯示，不再拿來插隊，否則後面的高優先序任務會跳到前面還沒做的基礎任務之前。
    let parent_open = |t: &Flat| t.parent.is_none_or(|p| OPEN.contains(&tasks[p]["status"].as_str().unwrap_or("")));
    let mut candidates: Vec<&Flat> = all.iter().filter(|t| !t.has_subtasks && OPEN.contains(&t.status.as_str()) && parent_open(t) && eligible(t, &all)).collect();
    candidates.sort_by(|a, b| {
        ((b.status != "pending") as u8).cmp(&((a.status != "pending") as u8))
            .then_with(|| (a.index, a.sub_index).cmp(&(b.index, b.sub_index)))
    });
    Ok(candidates.first().map(|t| t.id.clone()))
}

pub fn set_status(root: &Path, id: &str, status: &str) -> Result<Value> {
    if !TASK_STATUSES.contains(&status) {
        crate::bail!("無效任務狀態：{status}");
    }
    mutate(root, |store| {
        let tag = store["currentTag"].as_str().unwrap_or("master").to_string();
        let mut tasks = normalize(&group_tasks(store), true)?;
        let all = flatten(&tasks);
        let Some(target) = all.iter().find(|t| t.id == id) else { crate::bail!("找不到任務 {id}") };
        if ["in-progress", "review", "done"].contains(&status) && !eligible(target, &all) {
            crate::bail!("任務 {id} 的依賴尚未完成");
        }
        let target_subs: Vec<Value> = if target.sub_index.is_none() { tasks[target.index]["subtasks"].as_array().cloned().unwrap_or_default() } else { vec![] };
        if status == "done" && target_subs.iter().any(|t| t["status"] != "done") {
            crate::bail!("子任務尚未完成");
        }
        let actual = match target.sub_index {
            None => &mut tasks[target.index],
            Some(k) => &mut tasks[target.index]["subtasks"][k],
        };
        let from = actual["status"].as_str().unwrap_or("pending").to_string();
        if status == "done" && from != "review" && from != "done" {
            crate::bail!("任務需先進入 review 再完成");
        }
        actual["status"] = json!(status);
        if target.parent.is_some() {
            let parent = &mut tasks[target.index];
            let all_done = parent["subtasks"].as_array().unwrap().iter().all(|t| t["status"] == "done");
            parent["status"] = json!(if all_done { "done" } else { "in-progress" });
        }
        // 重新打開已完成的前置任務，會讓依賴它的已完成工作失效，所以必須先重設那些任務。
        if from == "done" && status != "done" {
            let mut invalidated: HashSet<String> = HashSet::from([id.to_string()]);
            if target.parent.is_some() {
                invalidated.insert(js_string(&tasks[target.index]["id"]));
            }
            for sub in &target_subs {
                invalidated.insert(format!("{id}.{}", js_string(&sub["id"])));
            }
            loop {
                let mut changed = false;
                for t in &all {
                    if !invalidated.contains(&t.id) && t.deps.iter().any(|d| invalidated.contains(d)) {
                        if t.status != "pending" {
                            crate::bail!("請先重設依賴此任務的 {}", t.id);
                        }
                        invalidated.insert(t.id.clone());
                        changed = true;
                    }
                }
                if !changed {
                    break;
                }
            }
            if status == "pending" && target.parent.is_none() {
                if let Some(subs) = tasks[target.index]["subtasks"].as_array_mut() {
                    for sub in subs {
                        sub["status"] = json!("pending");
                    }
                }
            }
        }
        let actual = match target.sub_index {
            None => tasks[target.index].clone(),
            Some(k) => tasks[target.index]["subtasks"][k].clone(),
        };
        store["groups"][tag.as_str()]["tasks"] = Value::Array(tasks);
        push_event(store, json!({ "kind": "status", "tag": tag, "id": id, "from": from, "to": status, "at": now_iso() }));
        Ok(actual)
    })
}

/// archive 用：讀取任意 JSON 檔裡的 tasks 陣列。
pub fn tasks_in(file: &Path) -> Vec<Value> {
    read_json(file).and_then(|v| v["tasks"].as_array().cloned()).unwrap_or_default()
}

pub fn group_metadata(root: &Path) -> Result<Value> {
    let store=load_store(root)?; let tag=store["currentTag"].as_str().unwrap_or("master");
    Ok(store["groups"][tag]["metadata"].clone())
}
pub fn assign_references(root: &Path, id: &str, tag: &str, references: Value) -> Result<()> {
    mutate(root, |store| {
        if store["currentTag"] != tag { crate::bail!(409; "任務群組已變更，請重新開啟任務"); }
        if id.is_empty() { store["groups"][tag]["metadata"]["references"]=references; return Ok(()); }
        let tasks=store["groups"][tag]["tasks"].as_array_mut().ok_or_else(|| AppError::new("沒有任務"))?;
        let parts:Vec<_>=id.split('.').collect();
        let task=tasks.iter_mut().find(|t| crate::core::util::js_string(&t["id"])==parts[0]).ok_or_else(||AppError::new("找不到任務"))?;
        if parts.len()==2 {
            let child=task["subtasks"].as_array_mut().and_then(|ts|ts.iter_mut().find(|t|crate::core::util::js_string(&t["id"])==parts[1])).ok_or_else(||AppError::new("找不到子任務"))?;
            child["references"]=references;
        } else { task["references"]=references; }
        Ok(())
    })
}

pub fn update_feature_references(root: &Path, feature: &Value, refs: &Value) -> Result<()> {
    mutate(root, |store| {
        let tag=store["currentTag"].as_str().unwrap_or("master").to_string();
        if feature.is_string() && store["groups"][&tag]["metadata"]["reference_feature"]==*feature {
            store["groups"][&tag]["metadata"]["references"]=refs.clone();
        }
        Ok(())
    })
}

/// Content revision excludes execution status so normal runner transitions keep approval valid.
fn content_revision(tasks: &[Value]) -> String {
    let mut content=tasks.to_vec();
    for task in &mut content {
        task.as_object_mut().unwrap().remove("status");
        for child in task["subtasks"].as_array_mut().into_iter().flatten() { child.as_object_mut().unwrap().remove("status"); }
    }
    hex::encode(Sha256::digest(serde_json::to_vec(&content).unwrap()))
}
fn store_revision(store: &Value) -> String {
    let tag=store["currentTag"].as_str().unwrap_or("master"); let meta=&store["groups"][tag]["metadata"];
    hex::encode(Sha256::digest(json!([content_revision(&group_tasks(store)),meta["references"],meta["prd_scope"],meta["prd_version"]]).to_string().as_bytes()))
}
pub fn revision(root: &Path) -> Result<String> { Ok(store_revision(&load_store(root)?)) }
pub fn edit_task(root: &Path, id: &str, tag: &str, expected: &str, patch: &Value) -> Result<Value> {
    crate::core::human::idle(root)?;
    mutate(root,|store| {
        if store["currentTag"] != tag { crate::bail!(409; "任務群組已變更，請重新開啟"); }
        let original=group_tasks(store);
        if store_revision(store) != expected { crate::bail!(409; "任務已被其他視窗修改，請重新載入後再編輯；你的草稿仍保留"); }
        let mut list=original.clone(); let parts:Vec<_>=id.split('.').collect();
        let parent=list.iter_mut().find(|t|js_string(&t["id"])==parts[0]).ok_or_else(||AppError::new("找不到任務"))?;
        let target=if parts.len()==2 { parent["subtasks"].as_array_mut().and_then(|ts|ts.iter_mut().find(|t|js_string(&t["id"])==parts[1])).ok_or_else(||AppError::new("找不到子任務"))? } else if parts.len()==1 { parent } else { crate::bail!(400; "任務 id 不正確"); };
        for field in ["title","description","details","testStrategy","priority","dependencies","acceptanceCriteria","requirement_ids","skills"] {
            if let Some(value)=patch.get(field) {
                if ["title","description","details","testStrategy","priority"].contains(&field) && (!value.is_string() || value.as_str().unwrap().len()>100000) { crate::bail!(400; "{field} 必須是文字且小於 100 KB"); }
                if ["dependencies","acceptanceCriteria","requirement_ids","skills"].contains(&field) && !value.is_array() { crate::bail!(400; "{field} 必須是陣列"); }
                if field=="priority" && !["high","medium","low"].contains(&value.as_str().unwrap_or("")) { crate::bail!(400; "優先序不正確"); }
                target[field]=value.clone();
            }
        }
        let mut list=normalize(&list,true)?;
        if content_revision(&list)==content_revision(&original) { return Ok(json!({"unchanged":true,"revision":store_revision(store)})); }
        let all=flatten(&list);
        let mut impacted=HashSet::from([id.to_string()]);
        if let Some((parent,_))=id.split_once('.') { impacted.insert(parent.to_string()); }
        loop {
            let before=impacted.len();
            for task in &all {
                if task.deps.iter().any(|d|impacted.contains(d)) || task.id.split_once('.').is_some_and(|(p,_)|impacted.contains(p)) { impacted.insert(task.id.clone()); }
            }
            if before==impacted.len() { break; }
        }
        for task in &mut list {
            let parent_id=js_string(&task["id"]); let mut child_changed=false;
            for child in task["subtasks"].as_array_mut().into_iter().flatten() {
                if impacted.contains(&format!("{parent_id}.{}",js_string(&child["id"]))) { child["status"]=json!("pending"); child_changed=true; }
            }
            if impacted.contains(&parent_id) || child_changed { task["status"]=json!("pending"); impacted.insert(parent_id); }
        }
        crate::core::state::update_state(root,|s| {
            s["task_approval"]=Value::Null;
            for id in &impacted { if let Some(states)=s["tasks"].as_object_mut() { states.remove(id); } }
            s["pipeline"]["status"]=json!("paused"); s["pipeline"]["reason"]=json!("任務已人工修改，請重新檢視並核准任務");
        })?;
        store["groups"][tag]["tasks"]=json!(list);
        push_event(store,json!({"kind":"human-edit","task":id,"at":now_iso(),"before":original,"invalidated":impacted}));
        Ok(json!({"tasks":list,"invalidated":impacted,"revision":store_revision(store)}))
    })
}
