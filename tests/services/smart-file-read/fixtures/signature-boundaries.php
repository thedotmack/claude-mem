<?php
function read_value($opening = "{", $closing = "}") { return $opening . $closing; }
abstract class Api {
  abstract public function external(int $value): int;
}
