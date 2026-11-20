pub struct Item { pub value: i32 }
pub fn read(Item { value }: Item) -> i32 { value }
pub trait Api { fn external(value: i32) -> i32; }
