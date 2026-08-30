// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ui

import (
	"fmt"
	"sync"
	"time"
)

// spinnerDelay keeps fast operations free of any animation: nothing is
// drawn until an operation has already taken noticeably long.
const spinnerDelay = 150 * time.Millisecond

const spinnerInterval = 80 * time.Millisecond

var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

const clearLine = "\r\x1b[2K"

// Spinner is a progress indicator for one long-running operation. On an
// interactive stream it animates after a short delay; on a pipe it prints
// the message once and stays silent until the verdict line.
type Spinner struct {
	c       *Console
	mu      sync.Mutex
	message string
	stopped bool
	drawn   bool
	anim    bool
	stop    chan struct{}
	done    chan struct{}
}

var (
	activeMu      sync.Mutex
	activeSpinner *Spinner
)

// Spin starts a progress indicator. Only one spinner animates at a time;
// a nested request returns a silent spinner whose verdict still prints.
func (c *Console) Spin(message string) *Spinner {
	s := &Spinner{c: c, message: message}
	activeMu.Lock()
	nested := activeSpinner != nil
	if !nested {
		activeSpinner = s
	}
	activeMu.Unlock()
	if nested {
		return s
	}
	if !c.tty {
		_, _ = fmt.Fprintf(c.w, "%s...\n", message)
		return s
	}
	s.anim = true
	s.stop = make(chan struct{})
	s.done = make(chan struct{})
	go s.run()
	return s
}

func (s *Spinner) run() {
	defer close(s.done)
	delay := time.NewTimer(spinnerDelay)
	defer delay.Stop()
	select {
	case <-s.stop:
		return
	case <-delay.C:
	}
	ticker := time.NewTicker(spinnerInterval)
	defer ticker.Stop()
	frame := 0
	for {
		s.mu.Lock()
		message := s.message
		s.drawn = true
		s.mu.Unlock()
		_, _ = fmt.Fprintf(s.c.w, "%s%s %s", clearLine, s.c.Info(spinnerFrames[frame%len(spinnerFrames)]), message)
		frame++
		select {
		case <-s.stop:
			return
		case <-ticker.C:
		}
	}
}

// Update replaces the progress message on the next frame.
func (s *Spinner) Update(message string) {
	s.mu.Lock()
	s.message = message
	s.mu.Unlock()
}

// halt stops the animation and clears its line exactly once.
func (s *Spinner) halt() {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return
	}
	s.stopped = true
	s.mu.Unlock()
	if s.anim {
		close(s.stop)
		<-s.done
		s.mu.Lock()
		drawn := s.drawn
		s.mu.Unlock()
		if drawn {
			_, _ = fmt.Fprint(s.c.w, clearLine)
		}
	}
	activeMu.Lock()
	if activeSpinner == s {
		activeSpinner = nil
	}
	activeMu.Unlock()
}

// Stop removes the indicator without printing a verdict.
func (s *Spinner) Stop() { s.halt() }

// Done stops the indicator and prints a success verdict line.
func (s *Spinner) Done(format string, args ...any) {
	s.halt()
	s.c.Successf(format, args...)
}

// Fail stops the indicator and prints a failure verdict line.
func (s *Spinner) Fail(format string, args ...any) {
	s.halt()
	s.c.Failf(format, args...)
}

// Interrupt clears any active progress indicator; the interrupt handler
// calls it so Ctrl+C never leaves a partial animation line behind.
func Interrupt() {
	activeMu.Lock()
	s := activeSpinner
	activeMu.Unlock()
	if s != nil {
		s.halt()
	}
}
