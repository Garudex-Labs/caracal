// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Approval decision wakeup registry tests.

package internal

import (
	"testing"
	"time"
)

func TestApprovalWatchWakesSubscribers(t *testing.T) {
	w := newApprovalWatch()
	first, cancelFirst := w.subscribe("hold-1")
	second, cancelSecond := w.subscribe("hold-1")
	other, cancelOther := w.subscribe("hold-2")
	defer cancelFirst()
	defer cancelSecond()
	defer cancelOther()

	w.wake("hold-1")
	for name, ch := range map[string]<-chan struct{}{"first": first, "second": second} {
		select {
		case <-ch:
		case <-time.After(time.Second):
			t.Fatalf("%s waiter must wake on its hold's decision", name)
		}
	}
	select {
	case <-other:
		t.Fatal("a decision must not wake waiters on other holds")
	default:
	}
}

func TestApprovalWatchCancelAndSpuriousWake(t *testing.T) {
	w := newApprovalWatch()
	ch, cancel := w.subscribe("hold-1")
	cancel()
	w.wake("hold-1")
	select {
	case <-ch:
		t.Fatal("a cancelled waiter must not receive wakeups")
	default:
	}
	// Waking with no subscribers and double-waking a live one must not block.
	w.wake("hold-none")
	live, cancelLive := w.subscribe("hold-1")
	defer cancelLive()
	w.wake("hold-1")
	w.wake("hold-1")
	select {
	case <-live:
	case <-time.After(time.Second):
		t.Fatal("live waiter must wake")
	}
}
