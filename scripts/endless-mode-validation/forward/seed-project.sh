#!/usr/bin/env zsh
# Seed the small Python project every scripted session starts from. Usage: seed-project.sh <dir>
set -e; d=$1; rm -rf $d; mkdir -p $d; cd $d; git init -q
cat > calc.py <<'PY'
def add(a, b):
    return a + b


def sub(a, b):
    return a - b


def mul(a, b):
    # TODO: handle non-numeric input with a clear TypeError
    return a * b


def divide(a, b):
    return a / b
PY
cat > test_calc.py <<'PY'
import unittest
from calc import add, sub, mul, divide


class CalcTest(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(2, 3), 5)

    def test_sub(self):
        self.assertEqual(sub(5, 3), 2)

    def test_mul(self):
        self.assertEqual(mul(4, 3), 12)

    def test_divide(self):
        self.assertEqual(divide(9, 3), 3)


if __name__ == "__main__":
    unittest.main()
PY
git add -A; git -c user.email=harness@example.invalid -c user.name=harness commit -qm seed
