class JobsController < ApplicationController
  def index
    result = JobSearchService.new(
      user: current_user,
      query: params.fetch(:query, ""),
      page: params.fetch(:page, 1)
    ).call

    @page_payload = JobsPageSerializer.new(result).as_json
  end
end
