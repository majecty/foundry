import { expect } from "chai";
import "mocha";
import * as TxSyncMessage from "../transactionSyncMessage";

describe("Check TransactionSyncMessage RLP encoding", function() {
    it("TransactionSyncMessage RLP encoding test", function() {
        const msg = new TxSyncMessage.TransactionSyncMessage({
            type: "transactions",
            data: []
        });
        expect([...msg.rlpBytes()]).deep.equal([192]);
    });
});
