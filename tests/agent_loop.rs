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

use researchgo_lib::agent::config::LlmConfig;
use serde_json::{json, Value};

use researchgo_lib::agent::agent_loop;

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
  let cfg = LlmConfig {
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

  let second = agent_loop::call_model(&cfg, &messages)
    .await
    .expect("second turn");
  assert!(second.tool_calls.is_empty(), "the second turn is prose only");
  assert_eq!(second.text, "A SolidJS + Tauri app.");
}