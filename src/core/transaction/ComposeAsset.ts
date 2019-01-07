import * as _ from "lodash";

import {
    blake128,
    blake256,
    blake256WithKey,
    encodeSignatureTag,
    SignatureTag
} from "../../utils";
import { Asset } from "../Asset";
import { AssetScheme } from "../AssetScheme";
import {
    AssetTransferInput,
    H160,
    H256,
    PlatformAddress,
    U64
} from "../classes";
import { AssetTransaction, Transaction } from "../Transaction";
import { NetworkId } from "../types";
import { AssetMintOutput } from "./AssetMintOutput";

const RLP = require("rlp");

export class ComposeAsset extends Transaction implements AssetTransaction {
    private readonly _transaction: AssetComposeTransaction;
    private readonly approvals: string[];
    public constructor(input: {
        networkId: NetworkId;
        shardId: number;
        metadata: string;
        approver: PlatformAddress | null;
        administrator: PlatformAddress | null;
        allowedScriptHashes: H160[];
        inputs: AssetTransferInput[];
        output: AssetMintOutput;
        approvals: string[];
    }) {
        super(input.networkId);

        this._transaction = new AssetComposeTransaction(input);
        this.approvals = input.approvals;
    }

    /**
     * Get the tracker of an AssetComposeTransaction.
     * @returns A transaction hash.
     */
    public tracker(): H256 {
        return new H256(blake256(this._transaction.rlpBytes()));
    }

    /**
     * Get a hash of the transaction that doesn't contain the scripts. The hash
     * is used as a message to create a signature for a transaction.
     * @returns A hash.
     */
    public hashWithoutScript(params?: {
        tag: SignatureTag;
        index: number;
    }): H256 {
        const {
            tag = { input: "all", output: "all" } as SignatureTag,
            index = null
        } = params || {};

        let inputs: AssetTransferInput[];
        if (tag.input === "all") {
            inputs = this._transaction.inputs.map(input =>
                input.withoutScript()
            );
        } else if (tag.input === "single") {
            if (typeof index !== "number") {
                throw Error(`Unexpected value of the index: ${index}`);
            }
            inputs = [this._transaction.inputs[index].withoutScript()];
        } else {
            throw Error(`Unexpected value of the tag input: ${tag.input}`);
        }
        let output: AssetMintOutput;
        if (tag.output === "all") {
            output = this._transaction.output;
        } else if (Array.isArray(tag.output) && tag.output.length === 0) {
            // NOTE: An empty array is allowed only
            output = new AssetMintOutput({
                lockScriptHash: new H160(
                    "0000000000000000000000000000000000000000"
                ),
                parameters: [],
                amount: null
            });
        } else {
            throw Error(`Unexpected value of the tag output: ${tag.output}`);
        }
        const {
            networkId,
            shardId,
            metadata,
            approver,
            administrator,
            allowedScriptHashes
        } = this._transaction;
        return new H256(
            blake256WithKey(
                new AssetComposeTransaction({
                    networkId,
                    shardId,
                    metadata,
                    approver,
                    administrator,
                    allowedScriptHashes,
                    inputs,
                    output
                }).rlpBytes(),
                Buffer.from(blake128(encodeSignatureTag(tag)), "hex")
            )
        );
    }

    /**
     * Add an AssetTransferInput to spend.
     * @param inputs An array of either an AssetTransferInput or an Asset.
     * @returns The modified ComposeAsset.
     */
    public addInputs(
        inputs: AssetTransferInput | Asset | Array<AssetTransferInput | Asset>,
        ...rest: Array<AssetTransferInput | Asset>
    ): ComposeAsset {
        if (!Array.isArray(inputs)) {
            inputs = [inputs, ...rest];
        }
        inputs.forEach((input: AssetTransferInput | Asset, index: number) => {
            if (input instanceof AssetTransferInput) {
                this._transaction.inputs.push(input);
            } else if (input instanceof Asset) {
                this._transaction.inputs.push(input.createTransferInput());
            } else {
                throw Error(
                    `Expected an array of either AssetTransferInput or Asset but found ${input} at ${index}`
                );
            }
        });
        return this;
    }

    public input(index: number): AssetTransferInput | null {
        if (this._transaction.inputs.length <= index) {
            return null;
        }
        return this._transaction.inputs[index];
    }

    /**
     * Get the output of this transaction.
     * @returns An Asset.
     */
    public getComposedAsset(): Asset {
        const { lockScriptHash, parameters, amount } = this._transaction.output;
        if (amount === null) {
            throw Error("not implemented");
        }
        return new Asset({
            assetType: this.getAssetSchemeAddress(),
            lockScriptHash,
            parameters,
            amount: amount == null ? U64.ensure(U64.MAX_VALUE) : amount,
            tracker: this.tracker(),
            transactionOutputIndex: 0
        });
    }

    /**
     * Get the asset scheme of this transaction.
     * @return An AssetScheme.
     */
    public getAssetScheme(): AssetScheme {
        const {
            networkId,
            shardId,
            metadata,
            inputs,
            output: { amount },
            approver,
            administrator,
            allowedScriptHashes
        } = this._transaction;
        if (amount == null) {
            throw Error("not implemented");
        }
        return new AssetScheme({
            networkId,
            shardId,
            metadata,
            amount,
            approver,
            administrator,
            allowedScriptHashes,
            pool: _.toPairs(
                // NOTE: Get the sum of each asset type
                inputs.reduce((acc: { [assetType: string]: U64 }, input) => {
                    const { assetType, amount: assetAmount } = input.prevOut;
                    // FIXME: Check integer overflow
                    acc[assetType.value] = U64.plus(
                        acc[assetType.value],
                        assetAmount
                    );
                    return acc;
                }, {})
            ).map(([assetType, assetAmount]) => ({
                assetType: H256.ensure(assetType),
                amount: U64.ensure(assetAmount as number)
            }))
        });
    }

    /**
     * Get the address of the asset scheme. An asset scheme address equals to an
     * asset type value.
     * @returns An asset scheme address which is H256.
     */
    public getAssetSchemeAddress(): H256 {
        const { shardId } = this._transaction;
        const blake = blake256WithKey(
            this.tracker().value,
            new Uint8Array([
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0xff,
                0xff,
                0xff,
                0xff,
                0xff,
                0xff,
                0xff,
                0xff
            ])
        );
        const shardPrefix = convertU16toHex(shardId);
        const prefix = `5300${shardPrefix}`;
        return new H256(
            blake.replace(new RegExp(`^.{${prefix.length}}`), prefix)
        );
    }

    /**
     * Get the asset address of the output.
     * @returns An asset address which is H256.
     */
    public getAssetAddress(): H256 {
        const { shardId } = this._transaction;
        const blake = blake256WithKey(
            this.tracker().value,
            new Uint8Array([
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00,
                0x00
            ])
        );
        const shardPrefix = convertU16toHex(shardId);
        const prefix = `4100${shardPrefix}`;
        return new H256(
            blake.replace(new RegExp(`^.{${prefix.length}}`), prefix)
        );
    }

    public type(): string {
        return "composeAsset";
    }

    protected actionToEncodeObject(): any[] {
        const encoded = this._transaction.toEncodeObject();
        encoded.push(this.approvals);
        return encoded;
    }

    protected actionToJSON(): any {
        const json = this._transaction.toJSON();
        json.approvals = this.approvals;
        return json;
    }
}

function convertU16toHex(id: number) {
    const hi: string = ("0" + ((id >> 8) & 0xff).toString(16)).slice(-2);
    const lo: string = ("0" + (id & 0xff).toString(16)).slice(-2);
    return hi + lo;
}

/**
 * Compose assets.
 */
class AssetComposeTransaction {
    public readonly networkId: NetworkId;
    public readonly shardId: number;
    public readonly metadata: string;
    public readonly approver: PlatformAddress | null;
    public readonly administrator: PlatformAddress | null;
    public readonly allowedScriptHashes: H160[];
    public readonly inputs: AssetTransferInput[];
    public readonly output: AssetMintOutput;

    /**
     * @param params.networkId A network ID of the transaction.
     * @param params.shardId A shard ID of the transaction.
     * @param params.metadata A metadata of the asset.
     * @param params.approver A approver of the asset.
     * @param params.administrator A administrator of the asset.
     * @param params.allowedScriptHashes Allowed lock script hashes of the asset.
     * @param params.inputs A list of inputs of the transaction.
     * @param params.output An output of the transaction.
     */
    constructor(params: {
        networkId: NetworkId;
        shardId: number;
        metadata: string;
        approver: PlatformAddress | null;
        administrator: PlatformAddress | null;
        allowedScriptHashes: H160[];
        inputs: AssetTransferInput[];
        output: AssetMintOutput;
    }) {
        const {
            networkId,
            shardId,
            metadata,
            approver,
            administrator,
            allowedScriptHashes,
            inputs,
            output
        } = params;
        this.networkId = networkId;
        this.shardId = shardId;
        this.metadata = metadata;
        this.approver =
            approver === null ? null : PlatformAddress.ensure(approver);
        this.administrator =
            administrator === null
                ? null
                : PlatformAddress.ensure(administrator);
        this.allowedScriptHashes = allowedScriptHashes;
        this.inputs = inputs;
        this.output = new AssetMintOutput(output);
    }

    /**
     * Convert to an AssetComposeTransaction JSON object.
     * @returns An AssetComposeTransaction JSON object.
     */
    public toJSON(): any {
        return {
            networkId: this.networkId,
            shardId: this.shardId,
            metadata: this.metadata,
            approver: this.approver === null ? null : this.approver.toString(),
            administrator:
                this.administrator === null
                    ? null
                    : this.administrator.toString(),
            allowedScriptHashes: this.allowedScriptHashes.map(hash =>
                hash.toJSON()
            ),
            output: this.output.toJSON(),
            inputs: this.inputs.map(input => input.toJSON())
        };
    }

    /**
     * Convert to an object for RLP encoding.
     */
    public toEncodeObject() {
        return [
            0x16,
            this.networkId,
            this.shardId,
            this.metadata,
            this.approver ? [this.approver.toString()] : [],
            this.administrator ? [this.administrator.toString()] : [],
            this.allowedScriptHashes.map(hash => hash.toEncodeObject()),
            this.inputs.map(input => input.toEncodeObject()),
            this.output.lockScriptHash.toEncodeObject(),
            this.output.parameters.map(parameter => Buffer.from(parameter)),
            this.output.amount != null
                ? [this.output.amount.toEncodeObject()]
                : []
        ];
    }

    /**
     * Convert to RLP bytes.
     */
    public rlpBytes(): Buffer {
        return RLP.encode(this.toEncodeObject());
    }
}
