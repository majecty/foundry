// Copyright 2018-2020 Kodebox, Inc.
// This file is part of CodeChain.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

use awc::Client;
use ckey::{Ed25519Private as Private, Ed25519Public as Public, Signature};
use coordinator::Transaction;
use serde_json::Value;
use std::process::{Child, Command};
use std::sync::atomic::AtomicUsize;
use std::{collections::HashMap, sync::atomic::Ordering};

static ID_COUNT: AtomicUsize = AtomicUsize::new(1);

pub struct FoundryNode {
    child: Child,
}

impl Drop for FoundryNode {
    fn drop(&mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
    }
}

pub struct RunNodeArgs {
    pub foundry_path: String,
    pub rust_log: String,
    pub app_desc_path: String,
    pub link_desc_path: String,
    pub config_path: String,
    pub graphql_port: u16,
}

pub fn run_node(
    RunNodeArgs {
        foundry_path,
        rust_log,
        app_desc_path,
        link_desc_path,
        config_path,
        graphql_port,
    }: RunNodeArgs,
) -> FoundryNode {
    let path = std::fs::canonicalize(foundry_path).unwrap();
    let mut command = Command::new(path);
    let id = ID_COUNT.fetch_add(1, Ordering::SeqCst);
    FoundryNode {
        child: command
            .env("RUST_LOG", rust_log)
            .arg("--app-desc-path")
            .arg(app_desc_path)
            .arg("--link-desc-path")
            .arg(link_desc_path)
            .arg("--config")
            .arg(config_path)
            .arg("--graphql-port")
            .arg(format!("{}", graphql_port))
            .arg("-i")
            .arg(format!("{}", id))
            .spawn()
            .unwrap(),
    }
}

pub async fn request_query(port: u16, module: &str, query: &str, variables: &str) -> String {
    let query: HashMap<String, &str> =
        vec![("query".to_owned(), query), ("variables".to_owned(), variables)].into_iter().collect();

    let client = Client::new();
    let request = client.get(&format!("http://localhost:{}/{}/graphql", port, module)).query(&query).unwrap();
    let response_bytes = request.send().await.unwrap().body().await.unwrap();
    let response = std::str::from_utf8(&response_bytes).expect("GraphQL server must return utf8-encoded string");
    response.to_owned()
}

pub async fn get_latest_block(port: u16) -> u64 {
    let query_result = request_query(port, "engine", "{block{header{number}}}", "{}").await;
    let value: Value = serde_json::from_str(&query_result).unwrap();
    value["data"]["block"]["header"]["number"].as_u64().unwrap()
}

/// This is a copy from `foundry-timestamp`.
#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct SignedTransaction {
    pub signature: Signature,
    pub signer_public: Public,
    pub action: Vec<u8>,
}

pub fn sign_tx(public: &Public, private: &Private, tx_type: String, action: Vec<u8>) -> Transaction {
    let tx = SignedTransaction {
        signature: ckey::sign(&action, private),
        signer_public: *public,
        action,
    };
    Transaction::new(tx_type, serde_cbor::to_vec(&tx).unwrap())
}

pub async fn send_tx(port: u16, tx_type: &str, body: &[u8]) -> Result<(), ()> {
    let query = "mutation Test($txType: String!, $body: String!) {
        sendTransaction(txType: $txType, body: $body)
    }";
    let mut variables = Value::Object(Default::default());
    variables["txType"] = Value::String(tx_type.to_owned());
    variables["body"] = Value::String(hex::encode(body));

    let query_result = request_query(port, "engine", query, &variables.to_string()).await;
    let value: Value = serde_json::from_str(&query_result).unwrap();

    if value["data"]["sendTransaction"].as_str().unwrap() == "Done" {
        Ok(())
    } else {
        Err(())
    }
}

pub async fn create_tx_hello(port: u16, public: &Public, private: &Private, sequence: u64) -> Transaction {
    let query = "query Test($seq: Int!) {
        txHello(seq: $seq)
    }";
    let mut variables = Value::Object(Default::default());
    variables["seq"] = Value::Number(sequence.into());

    let query_result = request_query(port, "module-account", query, &variables.to_string()).await;
    let value: Value = serde_json::from_str(&query_result).unwrap();
    let tx = hex::decode(value["data"]["txHello"].as_str().unwrap()).unwrap();

    sign_tx(public, private, "hello".to_owned(), tx)
}
