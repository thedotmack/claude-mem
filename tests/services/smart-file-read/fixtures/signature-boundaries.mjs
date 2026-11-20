const café = 1;
export default function unpack(
  { value = "{" },
  suffixNeedle = "}"
) { return value + suffixNeedle; }
export const convert = (
  { value }, options = { enabled: true }
) => { return value; }, shallow = () => ({ result: 1 });
export let callback = function ({ value }, ending = "}") { return value + ending; };
var legacy = ({ value }, { mode } = { mode: "{" }) => { return value + mode; };
class Api {
  read({ value }, ending = "{") { return value + ending; }
  field = ({ value }, options = { enabled: true }) => { return value; };
  *items({ value }, ending = "{") { yield value + ending; }
}
export function* values({ value }, ending = "{") { yield value + ending; }
