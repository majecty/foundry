// Copyright 2018 Kodebox, Inc.
// This file is part of CodeChain.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

use std::sync::Arc;

use ccore::block::IsBlock;
use ccore::{EngineClient, EngineInfo, MinerService, MiningBlockChainClient, TermInfo};
use cjson::bytes::Bytes;
use ctypes::BlockHash;
use jsonrpc_core::Result;

use super::super::errors;
use super::super::traits::Miner;
use super::super::types::Work;

pub struct MinerClient<C, M> {
    client: Arc<C>,
    miner: Arc<M>,
}

impl<C, M> MinerClient<C, M> {
    pub fn new(client: Arc<C>, miner: Arc<M>) -> Self {
        Self {
            client,
            miner,
        }
    }
}

impl<C, M> Miner for MinerClient<C, M>
where
    C: MiningBlockChainClient + EngineClient + EngineInfo + TermInfo + 'static,
    M: MinerService + 'static,
{
    fn get_work(&self) -> Result<Work> {
        if !self.miner.can_produce_work_package() {
            cwarn!(MINER, "Cannot give work package - engine seals internally.");
            return Err(errors::no_work_required())
        }
        if self.miner.authoring_params().author.is_zero() {
            cwarn!(MINER, "Cannot give work package - no author is configured. Use --author to configure!");
            return Err(errors::no_author())
        }
        self.miner
            .map_sealing_work(&*self.client, |b| {
                let pow_hash = b.hash();
                let target = self.client.score_to_target(b.block().header().score());

                Ok(Work {
                    pow_hash,
                    target,
                })
            })
            .unwrap_or_else(|| Err(errors::internal("No work found.", "")))
    }

    fn submit_work(&self, pow_hash: BlockHash, seal: Vec<Bytes>) -> Result<bool> {
        if !self.miner.can_produce_work_package() {
            cwarn!(MINER, "Cannot give work package - engine seals internally.");
            return Err(errors::no_work_required())
        }
        let seal = seal.iter().cloned().map(Into::into).collect();
        Ok(self.miner.submit_seal(&*self.client, pow_hash, seal).is_ok())
    }
}
