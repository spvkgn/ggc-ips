import argparse
import ipaddress
import json
import re
import os
from pathlib import Path
from collections import defaultdict

import maxminddb

DB_PATH = 'country_asn.mmdb'

DEFAULT_ASN = 'AS15169'
DEFAULT_RANGES = '74.125.0.0/16 142.250.0.0/15 172.217.0.0/16 173.194.0.0/16 209.85.128.0/17'

TARGET_ASN = (os.environ.get('TARGET_ASN') or DEFAULT_ASN).strip()
TARGET_RANGES = [
    ipaddress.ip_network(r)
    for r in re.split(r'[\s,]+', os.environ.get('TARGET_RANGES') or DEFAULT_RANGES)
    if r
]

# IPInfo returns these non-country values in `country` for some records.
SPECIAL_CODES = {'', 'XL', 'XD', 'XA', 'ZZ'}
ISO_CODE_RE = re.compile(r'^[A-Z]{2}$')


def is_real_country_code(code: str) -> bool:
    return bool(code) and code not in SPECIAL_CODES and ISO_CODE_RE.match(code) is not None


def is_host(net: ipaddress._BaseNetwork) -> bool:
    return net.prefixlen == net.max_prefixlen


def format_network(net: ipaddress._BaseNetwork) -> str:
    return str(net.network_address) if is_host(net) else str(net)


def in_target(network: ipaddress._BaseNetwork) -> bool:
    for target in TARGET_RANGES:
        if network.version != target.version:
            continue
        if network.subnet_of(target):
            return True
    return False


def collect(db_path: str):
    found: dict[str, list] = defaultdict(list)
    country_names: dict[str, str] = {}
    special_found: dict[str, int] = defaultdict(int)
    with maxminddb.open_database(db_path) as reader:
        for network, record in reader:
            if not record:
                continue
            if record.get('asn') != TARGET_ASN:
                continue
            if not in_target(network):
                continue
            code = record.get('country') or ''
            if not is_real_country_code(code):
                special_found[code or '<empty>'] += 1
                continue
            country_names.setdefault(code, record.get('country_name') or code)
            found[code].append(network)
    return found, country_names, special_found


def write_country(code: str, name: str, subnets: list, out_dir: Path) -> Path:
    country_dir = out_dir / code
    country_dir.mkdir(parents=True, exist_ok=True)
    out_file = country_dir / f'{code}.txt'
    out_file.write_text('\n'.join(format_network(n) for n in subnets) + '\n')
    return out_file


def main() -> None:
    ap = argparse.ArgumentParser(
        description='Report AS15169 networks (within TARGET_RANGES) by country.'
    )
    ap.add_argument('--db', default=DB_PATH, help='path to country_asn.mmdb')
    ap.add_argument('--out-dir', type=Path, default=Path('work'),
                    help='output directory for --write (default: work/)')
    ap.add_argument('--write', action='store_true',
                    help='write per-country files and _manifest.json')
    args = ap.parse_args()

    found, country_names, special_found = collect(args.db)

    total_networks = 0
    for code in sorted(found, key=lambda c: (-len(found[c]), c)):
        subnets = sorted(found[code], key=lambda n: (n.version, int(n.network_address)))
        hosts = sum(1 for n in subnets if is_host(n))
        name = country_names.get(code, code)
        total_networks += len(subnets)
        print(f'[{code}] {name}: {len(subnets)} total '
              f'(hosts {hosts}, subnets {len(subnets) - hosts})')

    print()
    print(f'Summary: {len(found)} countries, {total_networks} networks total')

    if special_found:
        print()
        print('Special / non-country codes (excluded from the count above):')
        for code, cnt in sorted(special_found.items()):
            print(f'  {code!r}: {cnt} networks')

    if args.write:
        args.out_dir.mkdir(parents=True, exist_ok=True)
        for code, subnets in found.items():
            subnets = sorted(subnets, key=lambda n: (n.version, int(n.network_address)))
            write_country(code, country_names[code], subnets, args.out_dir)
        manifest = {code: {"name": country_names[code]} for code in found}
        (args.out_dir / '_manifest.json').write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + '\n'
        )
        print(f'\nWrote {len(found)} country dirs to {args.out_dir}/')

    if not found:
        print('::warning::no AS15169 networks found in TARGET_RANGES')


if __name__ == '__main__':
    main()
