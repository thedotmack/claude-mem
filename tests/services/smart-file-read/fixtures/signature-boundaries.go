package owned
func read(value struct { N int }) int { return value.N }
func external(value int) int
