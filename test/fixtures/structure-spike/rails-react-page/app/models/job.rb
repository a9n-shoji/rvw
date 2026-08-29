class Job < ApplicationRecord
  belongs_to :company

  scope :search, ->(query) {
    where("title ILIKE :query OR description ILIKE :query", query: "%#{query}%")
  }
end
