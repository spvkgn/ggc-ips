#!/usr/bin/env bash
set -euo pipefail

concurrency=300
rate=1000

usage() {
    echo "Usage: $0 [-c N] [-r RATE] <input-file> [<output-file>]" >&2
    echo "  -c N       tlsx concurrency (default: 300)" >&2
    echo "  -r RATE    naabu packets per second (default: 1000)" >&2
    echo "  output-file defaults to <input>_ggc.txt" >&2
    echo "" >&2
    echo "Required environment variables:" >&2
    echo "  GGC_SNI    TLS SNI to probe" >&2
    echo "  GGC_CN     certificate CN to match" >&2
    exit 1
}

while getopts ":c:r:" opt; do
    case "$opt" in
        c)
            if [[ ! "$OPTARG" =~ ^[0-9]+$ ]] || (( OPTARG < 1 )); then
                echo "Error: -c requires a positive integer, got '$OPTARG'" >&2
                exit 1
            fi
            concurrency="$OPTARG"
            ;;
        r)
            if [[ ! "$OPTARG" =~ ^[0-9]+$ ]] || (( OPTARG < 1 )); then
                echo "Error: -r requires a positive integer, got '$OPTARG'" >&2
                exit 1
            fi
            rate="$OPTARG"
            ;;
        \?)
            echo "Error: unknown option -$OPTARG" >&2
            usage
            ;;
        :)
            echo "Error: option -$OPTARG requires an argument" >&2
            usage
            ;;
    esac
done
shift $((OPTIND - 1))

if [[ $# -lt 1 ]] || [[ $# -gt 2 ]]; then
    usage
fi

: "${GGC_SNI:?GGC_SNI environment variable must be set}"
: "${GGC_CN:?GGC_CN environment variable must be set}"

input_file="$1"
output_file="${2:-${input_file%.*}_ggc.txt}"

if [[ ! -r "$input_file" ]]; then
    echo "Error: cannot read file '$input_file'" >&2
    exit 1
fi

mkdir -p "$(dirname "$output_file")"

save_cidrs() {
    local cn="$1"
    local out_file="$2"
    local ips cidrs

    ips=$(jq --arg cn "$cn" -Rr 'fromjson? | select(.subject_cn == $cn) | .ip // empty')

    if [[ -n "$ips" ]]; then
        cidrs=$(printf '%s\n' "$ips" | cidr-merger)
        if [[ -n "$cidrs" ]]; then
            printf '%s\n' "$cidrs" > "$out_file"
            echo "Written: $out_file"
            return
        fi
    fi

    echo "No matches for $cn, skipping $out_file"
}

sudo naabu -silent -p 443 -s s -rate "$rate" -warm-up-time 0 -j -l "$input_file" | \
    jq --unbuffered -Rr 'fromjson? | .ip // empty' | \
    tlsx -silent -ro -sni "$GGC_SNI" -sm auto -min-version tls13 -max-version tls13 -c "$concurrency" -timeout 5 -j | \
    save_cidrs "$GGC_CN" "$output_file"
