//! End-to-end check of the model call against a stand-in endpoint.
//!
//! The point is the parts that cannot be tested in isolation: that a streamed
//! reply reassembles into one assistant message, that tool-call arguments split
//! across deltas become valid JSON, and that usage lands where the renderer
//! will read it. Each of those has failed in a real harness, and each fails
//! silently — the turn completes and the transcript is simply wrong.
//!
//! The server is spawned by the test, so this needs no network and no key.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;

use researchgo_lib::agent::config::ResolvedModel;
use serde_json::{json, Value};

use researchgo_lib::agent::agent_loop;

#[tokio::test]
async fn text_arrives_before_the_response_finishes() {
  let listener = TcpListener::bind("127.0.0.1:0").unwrap();
  let port = listener.local_addr().unwrap().port();
  let (tx, rx) = std::sync::mpsc::channel();
  let server = std::thread::spawn(move || {
    let (mut socket, _) = listener.accept().unwrap();
    socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
    let mut reader = BufReader::new(socket.try_clone().unwrap());
    let mut length = 0;
    loop {
      let mut line = String::new();
      assert!(reader.read_line(&mut line).unwrap() > 0);
      if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
        length = value.trim().parse::<usize>().unwrap();
      }
      if line.trim().is_empty() { break; }
    }
    let mut body = vec![0; length];
    std::io::Read::read_exact(&mut reader, &mut body).unwrap();
    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").unwrap();
    let first = "data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\n";
    let split = first.find('你').unwrap() + 1;
    socket.write_all(&first.as_bytes()[..split]).unwrap();
    socket.flush().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(30));
    socket.write_all(&first.as_bytes()[split..]).unwrap();
    socket.flush().unwrap();
    // The server cannot finish until the caller has received the first delta.
    rx.recv_timeout(std::time::Duration::from_secs(5)).expect("text delivered before EOF");
    socket.write_all(b"data: {\"choices\":[{\"delta\":{\"content\":\"!\"}}]}\n\ndata: [DONE]\n\n").unwrap();
  });
  let cfg = ResolvedModel {
    url: format!("http://127.0.0.1:{port}/v1"),
    api_key: "sk-test".into(), name: "mock".into(), model: "test-model".into(),
  };
  let mut deltas = Vec::new();
  let reply = agent_loop::call_model_streaming(&cfg, &[], |text| {
    deltas.push(text.to_string());
    if deltas.len() == 1 { tx.send(()).unwrap(); }
  }).await.expect("stream completes");
  server.join().unwrap();
  assert_eq!(deltas, vec!["你好", "!"]);
  assert_eq!(reply.text, "你好!");
  assert_eq!(reply.message["content"], "你好!");
}

#[tokio::test]
async fn workspace_tools_continue_after_a_nested_glob() {
  let root = std::env::temp_dir().join(format!(
    "researchgo-agent-tools-{}-{}",
    std::process::id(),
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
  ));
  std::fs::create_dir_all(&root).unwrap();
  // Clean up only this test's fixture, including if an assertion fails.
  struct Fixture(std::path::PathBuf);
  impl Drop for Fixture {
    fn drop(&mut self) {
      let _ = std::fs::remove_dir_all(&self.0);
    }
  }
  let _fixture = Fixture(root.clone());
  let nested = root.join("long-directory/".repeat(20));
  std::fs::create_dir_all(&nested).unwrap();
  std::fs::write(nested.join("notes.txt"), "unrelated file").unwrap();
  std::fs::write(root.join("package.json"), "{\"name\":\"fixture-project\"}").unwrap();

  let started = std::time::Instant::now();
  let found = researchgo_lib::agent::tools::run(
    &root, "glob", &json!({ "pattern": "**/*.json" }), "glob-1"
  ).await.expect("glob finishes even with nested nonmatching paths");
  assert_eq!(found.content, "package.json");
  assert!(started.elapsed() < std::time::Duration::from_secs(5));

  let read = researchgo_lib::agent::tools::run(
    &root, "read", &json!({ "path": found.content }), "read-1"
  ).await.expect("next tool reads the discovered file");
  assert!(read.content.contains("fixture-project"));
  let searched = researchgo_lib::agent::tools::run(
    &root, "grep", &json!({ "pattern": "fixture-project" }), "grep-1"
  ).await.expect("analysis continues to search");
  assert!(searched.content.contains("package.json:1:"));
}

/// Serves exactly two turns: one that asks for a tool, one that answers.
///
/// A listener on a port the OS picked, served from a thread in this process.
/// Written out rather than shelling out to the Node mock for the same bytes:
/// a test that needs a runtime installed to prove a parser works is a test that
/// stops working on a machine without one.
fn spawn_mock() -> u16 {
  let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
  let port = listener.local_addr().expect("addr").port();

  std::thread::spawn(move || {
    for turn in 0..2 {
      let Ok((mut socket, _)) = listener.accept() else { return };
      let mut reader = BufReader::new(socket.try_clone().expect("clone"));

      // Headers, then the body by content-length.
      let mut length = 0usize;
      loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
          return;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("content-length:") {
          length = lower.split(':').nth(1).unwrap_or("0").trim().parse().unwrap_or(0);
        }
        if line.trim().is_empty() {
          break;
        }
      }
      let mut body = vec![0u8; length];
      std::io::Read::read_exact(&mut reader, &mut body).ok();

      let _ = socket.write_all(
        format!(
          "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{}",
          frames(turn)
        )
        .as_bytes(),
      );
      let _ = socket.flush();
    }
  });

  port
}

fn frames(turn: usize) -> String {
  let mut out = String::new();
  let mut send = |delta: Value| {
    out.push_str(&format!(
      "data: {}\n\n",
      json!({ "choices": [{ "index": 0, "delta": delta, "finish_reason": null }] })
    ));
  };

  if turn == 0 {
    // Arguments split mid-token: the case a whole-call parser gets wrong.
    send(json!({ "content": "Reading." }));
    send(json!({
      "tool_calls": [{ "index": 0, "id": "call_1", "function": {
        "name": "read", "arguments": "{\"pa" } }]
    }));
    send(json!({
      "tool_calls": [{ "index": 0, "function": { "arguments": "th\":\"package.json\"}" } }]
    }));
  } else {
    send(json!({ "content": "A SolidJS + Tauri app." }));
  }

  out.push_str(&format!(
    "data: {}\n\n",
    json!({ "usage": { "prompt_tokens": 1200, "completion_tokens": 84,
                       "prompt_tokens_details": { "cached_tokens": 900 } } })
  ));
  out.push_str("data: [DONE]\n\n");
  out
}

#[tokio::test]
async fn a_streamed_reply_reassembles_into_one_message() {
  let port = spawn_mock();
  let cfg = ResolvedModel {
    url: format!("http://127.0.0.1:{port}/v1"),
    api_key: "sk-test".into(),
    name: "mock".into(),
    model: "test-model".into(),
  };

  let messages = vec![json!({ "role": "user", "content": "read package.json" })];

  let reply = agent_loop::call_model(&cfg, &messages)
    .await
    .expect("first turn");

  assert_eq!(reply.text, "Reading.");
  assert_eq!(reply.tool_calls.len(), 1);
  assert_eq!(reply.tool_calls[0].name, "read");
  assert_eq!(reply.tool_calls[0].id, "call_1");
  assert_eq!(
    reply.tool_calls[0].arguments.as_str().expect("arguments are text"),
    "{\"path\":\"package.json\"}"
  );
  assert_eq!(reply.input_tokens, 1200);
  assert_eq!(reply.output_tokens, 84);
  assert_eq!(reply.cache_read_tokens, 900);

  // The message going back into the transcript must be the same assistant turn
  // the panels rendered, or the next request contradicts what the user saw.
  assert_eq!(reply.message["role"], "assistant");
  // And it must be the shape the endpoint accepts on the way back in: text in
  // `content`, tool calls in their own field. A `tool_calls` part inside
  // `content` is a 400 on the next request — the turn dies right after the
  // first tool call.
  assert_eq!(reply.message["content"], "Reading.");
  let sent = reply.message["tool_calls"]
    .as_array()
    .expect("tool calls in their own field");
  assert_eq!(sent[0]["id"], "call_1");
  assert_eq!(sent[0]["type"], "function");
  assert_eq!(sent[0]["function"]["name"], "read");
  assert_eq!(
    sent[0]["function"]["arguments"].as_str().expect("arguments are text"),
    "{\"path\":\"package.json\"}"
  );

  // The second request carries the transcript the loop would really send:
  // the assistant message above plus the tool's result. This is the request
  // that failed with 400 before the message shape was fixed.
  let mut transcript = messages.clone();
  transcript.push(reply.message.clone());
  transcript.push(json!({
    "role": "tool",
    "tool_call_id": "call_1",
    "content": "1\t{\n2\t  \"name\": \"researchgo\"\n3\t}"
  }));

  let second = agent_loop::call_model(&cfg, &transcript)
    .await
    .expect("second turn");
  assert!(second.tool_calls.is_empty(), "the second turn is prose only");
  assert_eq!(second.text, "A SolidJS + Tauri app.");
}

/// Diagnostic against the real configured endpoint. Not part of the suite:
/// run explicitly with `cargo test --test agent_loop -- --ignored diag`.
///
/// Reproduces the exact code path the app uses — same client, same timeout,
/// same SSE parser — so a hang here is a hang in the app, and a return here
/// means the app's turn loop is where to look next.
#[tokio::test]
#[ignore = "diagnostic: hits the real endpoint with the stored key"]
async fn diag_real_endpoint() {
  let path = std::env::var("APPDATA")
    .map(|d| std::path::PathBuf::from(d).join("dev.researchgo.app").join("llm.json"))
    .expect("APPDATA");
  let raw = std::fs::read_to_string(&path).expect("llm.json");
  let file: Value = serde_json::from_str(&raw).expect("config parses");
  let active_name = file["active"]["name"].as_str().expect("an active entry");
  let active_model = file["active"]["model"].as_str().expect("an active model");
  let entry = file["configs"]
    .as_array()
    .expect("configs")
    .iter()
    .find(|c| c["name"].as_str() == Some(active_name))
    .expect("active entry present");
  let cfg = ResolvedModel {
    url: entry["url"].as_str().expect("url").to_string(),
    api_key: entry["apiKey"].as_str().expect("apiKey").to_string(),
    name: active_name.to_string(),
    model: active_model.to_string(),
  };

  eprintln!("[diag] endpoint {} model {}", cfg.url, cfg.model);

  let messages = vec![json!({
    "role": "user",
    "content": "Read the file package.json in the workspace and tell me the project name.",
  })];

  let started = std::time::Instant::now();
  let first = tokio::time::timeout(std::time::Duration::from_secs(90), agent_loop::call_model(&cfg, &messages)).await;
  eprintln!("[diag] first call settled after {:?}", started.elapsed());
  let reply = match first {
    Err(_) => panic!("[diag] first call still running after 90s — reproduced the hang"),
    Ok(Err(err)) => panic!("[diag] first call errored: {err}"),
    Ok(Ok(reply)) => reply,
  };

  eprintln!("[diag] text: {:?}", reply.text);
  eprintln!("[diag] tool_calls: {}", reply.tool_calls.len());
  eprintln!("[diag] message: {}", serde_json::to_string(&reply.message).unwrap());
  eprintln!("[diag] usage: {} in / {} out", reply.input_tokens, reply.output_tokens);

  if reply.tool_calls.is_empty() {
    eprintln!("[diag] first reply is prose only — the turn would end here");
    return;
  }

  // The request shape that used to 400, now with the fixed assistant message.
  let mut transcript = messages.clone();
  transcript.push(reply.message.clone());
  for call in &reply.tool_calls {
    transcript.push(json!({
      "role": "tool",
      "tool_call_id": call.id,
      "content": "1\t{\n2\t  \"name\": \"researchgo\"\n3\t}",
    }));
  }

  let started = std::time::Instant::now();
  let second = tokio::time::timeout(std::time::Duration::from_secs(90), agent_loop::call_model(&cfg, &transcript)).await;
  eprintln!("[diag] second call settled after {:?}", started.elapsed());
  match second {
    Err(_) => panic!("[diag] second call still running after 90s — the hang is in the tool-result round trip"),
    Ok(Err(err)) => panic!("[diag] second call errored: {err}"),
    Ok(Ok(reply)) => {
      eprintln!("[diag] second text: {:?}", reply.text);
      eprintln!("[diag] second tool_calls: {}", reply.tool_calls.len());
    }
  }
}
