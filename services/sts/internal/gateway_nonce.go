// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Replay-nonce tracking for HMAC-authenticated internal exchanges.

package internal

import (
	"context"
	"errors"
)

const gatewayNonceKeyPrefix = "caracal:sts:gw-nonce:"

var gatewayNonceTTL = 2 * gatewayExchangeSkew

// consumeGatewayNonce records the internal nonce as consumed and returns an error if
// the same nonce was already seen within the replay window. When Redis is
// unavailable the verifier fails closed so a captured signature cannot be
// replayed during an outage.
func (s *Server) consumeGatewayNonce(ctx context.Context, nonce string) error {
	if nonce == "" {
		return errors.New("gateway nonce required")
	}
	if s.redis == nil {
		return errors.New("gateway nonce store unavailable")
	}
	ok, err := s.redis.SetNXTTL(ctx, gatewayNonceKeyPrefix+nonce, "1", gatewayNonceTTL)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("gateway nonce replay")
	}
	return nil
}
