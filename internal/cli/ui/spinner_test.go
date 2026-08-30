// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ui

import (
	"bytes"
	"strings"
	"sync"
	"testing"
	"time"
)

// syncBuffer serializes writes between the spinner goroutine and the test.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestSpinnerNonInteractive(t *testing.T) {
	var buf syncBuffer
	c := NewConsole(&buf, false, false, 80)
	s := c.Spin("Checking items")
	s.Done("Checked %d items", 4)
	got := buf.String()
	if got != "Checking items...\n✓ Checked 4 items\n" {
		t.Errorf("non-interactive spinner output = %q", got)
	}
	if strings.Contains(got, "\r") {
		t.Error("pipe output must not contain carriage returns")
	}
}

func TestSpinnerFastOperationDrawsNothing(t *testing.T) {
	var buf syncBuffer
	c := NewConsole(&buf, true, true, 80)
	s := c.Spin("quick")
	s.Stop()
	if got := buf.String(); got != "" {
		t.Errorf("fast operation drew output: %q", got)
	}
}

func TestSpinnerAnimatesThenClears(t *testing.T) {
	var buf syncBuffer
	c := NewConsole(&buf, true, true, 80)
	s := c.Spin("working")
	time.Sleep(spinnerDelay + 3*spinnerInterval)
	s.Update("still working")
	time.Sleep(3 * spinnerInterval)
	s.Done("finished")
	got := buf.String()
	if !strings.Contains(got, "working") || !strings.Contains(got, "still working") {
		t.Errorf("frames missing messages: %q", got)
	}
	if !strings.HasSuffix(got, "finished\n") || !strings.Contains(got, "✓") {
		t.Errorf("verdict not printed after clear: %q", got)
	}
	if !strings.Contains(got, clearLine) {
		t.Errorf("animation line never cleared: %q", got)
	}
}

func TestSpinnerStopAfterVerdictIsSilent(t *testing.T) {
	var buf syncBuffer
	c := NewConsole(&buf, false, false, 80)
	s := c.Spin("op")
	s.Fail("broke")
	before := buf.String()
	s.Stop()
	if got := buf.String(); got != before {
		t.Errorf("Stop after verdict wrote output: %q", got)
	}
	if !strings.Contains(before, "✗ broke") {
		t.Errorf("verdict lost: %q", before)
	}
}

func TestOnlyOneSpinnerAnimates(t *testing.T) {
	var buf1, buf2 syncBuffer
	c1 := NewConsole(&buf1, true, true, 80)
	c2 := NewConsole(&buf2, true, true, 80)
	s1 := c1.Spin("outer")
	s2 := c2.Spin("inner")
	time.Sleep(spinnerDelay + 3*spinnerInterval)
	s2.Stop()
	s1.Stop()
	if strings.Contains(buf2.String(), "inner") {
		t.Errorf("nested spinner animated: %q", buf2.String())
	}
	if !strings.Contains(buf1.String(), "outer") {
		t.Errorf("primary spinner never drew: %q", buf1.String())
	}
}

func TestInterruptClearsActiveSpinner(t *testing.T) {
	var buf syncBuffer
	c := NewConsole(&buf, true, true, 80)
	s := c.Spin("long op")
	time.Sleep(spinnerDelay + 2*spinnerInterval)
	Interrupt()
	if !strings.HasSuffix(buf.String(), clearLine) {
		t.Errorf("interrupt left animation line: %q", buf.String())
	}
	s.Stop() // must be a safe no-op afterwards
	activeMu.Lock()
	defer activeMu.Unlock()
	if activeSpinner != nil {
		t.Error("active spinner not released after interrupt")
	}
}
