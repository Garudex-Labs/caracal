#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Shared interactive multi-select helper for local publishing scripts.

set -euo pipefail

pickItems() {
    local items=("$@")
    local n=${#items[@]}
    local cursor=0 i
    local selected=()
    local tty_state=''

    [[ -t 0 ]] || { echo "interactive terminal input is required" >&2; return 2; }

    for ((i = 0; i < n; i++)); do selected[i]=0; done

    printf '\nUse Up/Down to move, Space to toggle, "a" to toggle all, Enter to confirm, Esc to cancel.\n\n' >&2
    tput civis 2>/dev/null || true
    tty_state="$(stty -g 2>/dev/null || true)"
    stty -echo

    render() {
        for ((i = 0; i < n; i++)); do
            local mark=' '
            [[ ${selected[i]} -eq 1 ]] && mark='x'
            local pre='  '
            [[ $i -eq $cursor ]] && pre='> '
            printf '\r%s[%s] %s\033[K\n' "$pre" "$mark" "${items[i]}" >&2
        done
    }
    render

    while true; do
        local key='' rest=''
        if ! IFS= read -rsn1 key; then continue; fi
        if [[ $key == $'\x1b' ]]; then
            IFS= read -rsn2 -t 0.5 rest || rest=''
            key="$key$rest"
        fi
        case "$key" in
            $'\x1b[A') cursor=$(( (cursor - 1 + n) % n )) ;;
            $'\x1b[B') cursor=$(( (cursor + 1) % n )) ;;
            ' ') selected[cursor]=$((1 - selected[cursor])) ;;
            a|A)
                local any=0
                for ((i = 0; i < n; i++)); do [[ ${selected[i]} -eq 0 ]] && any=1; done
                for ((i = 0; i < n; i++)); do selected[i]=$any; done
                ;;
            '') break ;;
            $'\x1b') for ((i = 0; i < n; i++)); do selected[i]=0; done; break ;;
            *) continue ;;
        esac
        printf '\033[%dA' "$n" >&2
        render
    done

    [[ -z "$tty_state" ]] || stty "$tty_state"
    tput cnorm 2>/dev/null || true

    PICKED=()
    for ((i = 0; i < n; i++)); do
        [[ ${selected[i]} -eq 1 ]] && PICKED+=("${items[i]}")
    done
}
