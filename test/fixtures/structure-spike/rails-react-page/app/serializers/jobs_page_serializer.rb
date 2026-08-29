class JobsPageSerializer
  def initialize(result)
    @result = result
  end

  def as_json
    {
      query: @result.query,
      page: @result.page,
      facets: @result.facets,
      jobs: @result.jobs.map { |job| job.slice(:id, :title, :location) }
    }
  end
end
